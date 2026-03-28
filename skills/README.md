# Project Skills

This folder is the default project-local skills root for the runtime.

Each skill should live in its own directory and include a `SKILL.md` file:

```text
skills/
  my-skill/
    SKILL.md
```

The runtime auto-discovers skills from this folder and injects relevant ones per turn.

Current bundled snapshot:

```text
skills/
  marketingskills/
    <skill-name>/
      SKILL.md
```

Source: `https://github.com/coreyhaines31/marketingskills` (vendored snapshot; see `skills/marketingskills/UPSTREAM.md`).

