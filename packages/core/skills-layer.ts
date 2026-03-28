import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import type { AgentSkillsConfig } from "./agent-builder";
import { errorMessage } from "./errors";

const SKILL_FILE_NAME = "SKILL.md";
const SKILL_CACHE_TTL_MS = 10_000;
const DEFAULT_SKILL_ROOTS = [".agents/skills", ".claude/skills"];
const DEFAULT_MAX_SKILLS_PER_TURN = 2;
const DEFAULT_MAX_CHARS_PER_SKILL = 3_500;
const DEFAULT_MAX_TOTAL_CHARS = 7_000;

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "de", "del", "do", "en", "for", "from", "how",
  "i", "if", "in", "is", "it", "la", "las", "los", "me", "my", "of", "on", "or", "para", "por",
  "que", "quiero", "se", "the", "to", "una", "un", "with", "y",
]);

interface ResolvedAgentSkillsConfig {
  enabled: boolean;
  roots: string[];
  maxSkillsPerTurn: number;
  maxCharsPerSkill: number;
  maxTotalChars: number;
}

interface LoadedSkill {
  name: string;
  description: string;
  content: string;
  path: string;
  relPath: string;
  keywordSet: Set<string>;
}

interface SkillsCacheEntry {
  expiresAt: number;
  skills: LoadedSkill[];
}

export interface SkillContextBuildResult {
  section: string;
  selectedSkills: string[];
  availableSkills: number;
  errors: string[];
}

export interface BuildSkillContextInput {
  userInput: string;
  config?: AgentSkillsConfig;
  cwd?: string;
}

const skillsCache = new Map<string, SkillsCacheEntry>();

function normalizeConfig(config?: AgentSkillsConfig): ResolvedAgentSkillsConfig {
  const enabled = config?.enabled ?? true;
  const roots = (config?.roots?.length ? config.roots : DEFAULT_SKILL_ROOTS)
    .map((item) => item.trim())
    .filter(Boolean);
  const maxSkillsPerTurn = Math.max(1, config?.maxSkillsPerTurn ?? DEFAULT_MAX_SKILLS_PER_TURN);
  const maxCharsPerSkill = Math.max(500, config?.maxCharsPerSkill ?? DEFAULT_MAX_CHARS_PER_SKILL);
  const maxTotalChars = Math.max(2_000, config?.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS);
  return { enabled, roots, maxSkillsPerTurn, maxCharsPerSkill, maxTotalChars };
}

function splitFrontmatter(raw: string): { frontmatter: string; body: string } {
  const text = raw.replace(/\r\n/g, "\n");
  const standard = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (standard) {
    return { frontmatter: standard[1] ?? "", body: standard[2] ?? "" };
  }

  const inline = text.match(/^---\s*([\s\S]*?)\s*---\s*([\s\S]*)$/);
  if (inline) {
    return { frontmatter: inline[1] ?? "", body: inline[2] ?? "" };
  }

  return { frontmatter: "", body: text };
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseFrontmatterField(frontmatter: string, field: string): string {
  const lines = frontmatter.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const match = line.match(new RegExp(`^${field}\\s*:\\s*(.*)$`, "i"));
    if (!match) continue;

    const inlineValue = (match[1] ?? "").trim();
    if (inlineValue && inlineValue !== "|" && inlineValue !== ">") {
      return stripQuotes(inlineValue);
    }

    const parts: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const continuation = lines[j] ?? "";
      if (/^\s+/.test(continuation)) {
        parts.push(continuation.trim());
        continue;
      }
      break;
    }
    return stripQuotes(parts.join(" ").trim());
  }

  return "";
}

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]+/gu, " ")
    .split(/[\s/_-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
}

function trimContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const truncated = content.slice(0, Math.max(0, maxChars - 32)).trimEnd();
  return `${truncated}\n\n[Skill content truncated]`;
}

async function findSkillFiles(rootAbs: string, depth = 0): Promise<string[]> {
  if (depth > 3) return [];
  let entries;
  try {
    entries = await readdir(rootAbs, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = resolve(rootAbs, entry.name);
    if (entry.isFile() && entry.name === SKILL_FILE_NAME) {
      files.push(fullPath);
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...await findSkillFiles(fullPath, depth + 1));
    }
  }
  return files;
}

async function loadSkillsFromRoots(roots: string[], cwd: string): Promise<LoadedSkill[]> {
  const normalizedRoots = roots.map((root) => resolve(cwd, root)).sort();
  const cacheKey = normalizedRoots.join("|");
  const nowMs = Date.now();
  const cached = skillsCache.get(cacheKey);
  if (cached && cached.expiresAt > nowMs) return cached.skills;

  const skillPaths = new Set<string>();
  for (const root of normalizedRoots) {
    const files = await findSkillFiles(root);
    for (const filePath of files) skillPaths.add(filePath);
  }

  const loaded: LoadedSkill[] = [];
  for (const skillPath of [...skillPaths].sort()) {
    try {
      const raw = await readFile(skillPath, "utf8");
      const { frontmatter, body } = splitFrontmatter(raw);
      const folderName = basename(dirname(skillPath));
      const name = parseFrontmatterField(frontmatter, "name") || folderName;
      const description = parseFrontmatterField(frontmatter, "description");
      const content = body.trim() || raw.trim();
      const keywords = new Set<string>([
        ...tokenize(name),
        ...tokenize(description),
        ...tokenize(content.slice(0, 2_000)),
      ]);
      loaded.push({
        name: name.trim(),
        description: description.trim(),
        content,
        path: skillPath,
        relPath: relative(cwd, skillPath).replace(/\\/g, "/"),
        keywordSet: keywords,
      });
    } catch {
      // Ignore unreadable or malformed skill files.
    }
  }

  skillsCache.set(cacheKey, { expiresAt: nowMs + SKILL_CACHE_TTL_MS, skills: loaded });
  return loaded;
}

function selectSkills(skills: LoadedSkill[], userInput: string, maxSkills: number): LoadedSkill[] {
  const lowerInput = userInput.toLowerCase();
  const inputTokens = tokenize(lowerInput);
  const explicitRefs = new Set(
    [...lowerInput.matchAll(/\/([a-z0-9][a-z0-9-]{1,80})/g)].map((match) => match[1] ?? ""),
  );

  const scored = skills
    .map((skill) => {
      const skillName = skill.name.toLowerCase();
      const skillNameSpaces = skillName.replace(/-/g, " ");
      let score = 0;

      if (explicitRefs.has(skillName)) score += 1_000;
      if (lowerInput.includes(skillName)) score += 240;
      if (lowerInput.includes(skillNameSpaces)) score += 120;
      for (const token of inputTokens) {
        if (skill.keywordSet.has(token)) score += 6;
      }

      return { skill, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name));

  return scored.slice(0, maxSkills).map((item) => item.skill);
}

function buildSkillSection(selected: LoadedSkill[], config: ResolvedAgentSkillsConfig): string {
  if (selected.length === 0) return "";

  const lines: string[] = [
    "## Skill Context (Auto)",
    "",
    "The following local SKILL.md playbooks were selected for this turn.",
    "Use them as specialized guidance and adapt to available tools.",
    "",
  ];

  let budget = config.maxTotalChars;
  for (const skill of selected) {
    const header = `### ${skill.name}\nSource: ${skill.relPath}`;
    const desc = skill.description ? `\nDescription: ${skill.description}` : "";
    const usedByHeader = header.length + desc.length + 4;
    if (budget <= usedByHeader + 100) break;

    const maxForContent = Math.min(config.maxCharsPerSkill, budget - usedByHeader);
    const content = trimContent(skill.content, maxForContent);
    const block = `${header}${desc}\n\n${content}`;
    lines.push(block, "");
    budget -= block.length;
  }

  return lines.join("\n").trim();
}

export async function buildSkillContextSection(input: BuildSkillContextInput): Promise<SkillContextBuildResult> {
  const cwd = input.cwd ?? process.cwd();
  const config = normalizeConfig(input.config);
  const errors: string[] = [];

  if (!config.enabled) {
    return { section: "", selectedSkills: [], availableSkills: 0, errors };
  }

  let skills: LoadedSkill[] = [];
  try {
    skills = await loadSkillsFromRoots(config.roots, cwd);
  } catch (err) {
    errors.push(`skills load failed: ${errorMessage(err)}`);
    return { section: "", selectedSkills: [], availableSkills: 0, errors };
  }

  if (skills.length === 0) {
    return { section: "", selectedSkills: [], availableSkills: 0, errors };
  }

  const selected = selectSkills(skills, input.userInput, config.maxSkillsPerTurn);
  const section = buildSkillSection(selected, config);

  return {
    section,
    selectedSkills: selected.map((skill) => skill.name),
    availableSkills: skills.length,
    errors,
  };
}
