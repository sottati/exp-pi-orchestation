import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSkillContextSection } from "./skills-layer";

const tempDirs: string[] = [];

async function createTempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "skills-layer-test-"));
  tempDirs.push(dir);
  return dir;
}

async function writeSkill(
  cwd: string,
  skillName: string,
  description: string,
  body: string,
): Promise<void> {
  const skillDir = join(cwd, ".agents", "skills", skillName);
  await mkdir(skillDir, { recursive: true });
  const content = [
    "---",
    `name: ${skillName}`,
    `description: ${description}`,
    "---",
    body,
    "",
  ].join("\n");
  await writeFile(join(skillDir, "SKILL.md"), content, "utf8");
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    await rm(dir, { recursive: true, force: true });
  }
});

describe("skills-layer", () => {
  test("selects relevant skills based on user input", async () => {
    const cwd = await createTempRoot();
    await writeSkill(
      cwd,
      "copywriting",
      "Write and improve marketing copy for landing pages.",
      "# Copywriting\nUse direct response frameworks.",
    );
    await writeSkill(
      cwd,
      "seo-audit",
      "Audit SEO issues and technical metadata.",
      "# SEO Audit\nCheck title, meta description, headings.",
    );

    const result = await buildSkillContextSection({
      cwd,
      userInput: "Necesito mejorar el copywriting de mi landing page",
      config: {
        enabled: true,
        roots: [".agents/skills"],
        maxSkillsPerTurn: 2,
        maxCharsPerSkill: 1_500,
        maxTotalChars: 2_500,
      },
    });

    expect(result.availableSkills).toBe(2);
    expect(result.selectedSkills).toContain("copywriting");
    expect(result.section).toContain("## Skill Context (Auto)");
    expect(result.section).toContain("### copywriting");
  });

  test("returns empty section when disabled", async () => {
    const cwd = await createTempRoot();
    await writeSkill(
      cwd,
      "copywriting",
      "Write and improve marketing copy for landing pages.",
      "# Copywriting\nUse direct response frameworks.",
    );

    const result = await buildSkillContextSection({
      cwd,
      userInput: "quiero ayuda con copywriting",
      config: {
        enabled: false,
        roots: [".agents/skills"],
      },
    });

    expect(result.section).toBe("");
    expect(result.selectedSkills).toEqual([]);
  });

  test("limits selected skills by maxSkillsPerTurn", async () => {
    const cwd = await createTempRoot();
    await writeSkill(
      cwd,
      "copywriting",
      "Write and improve marketing copy.",
      "# Copywriting\nUse direct response frameworks.",
    );
    await writeSkill(
      cwd,
      "page-cro",
      "Optimize page conversion rate.",
      "# Page CRO\nFocus on CTA hierarchy.",
    );

    const result = await buildSkillContextSection({
      cwd,
      userInput: "quiero mejorar copywriting y page cro",
      config: {
        enabled: true,
        roots: [".agents/skills"],
        maxSkillsPerTurn: 1,
      },
    });

    expect(result.selectedSkills.length).toBe(1);
  });
});

