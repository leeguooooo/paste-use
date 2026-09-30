// SKILL.md is compiled into the binary, so `paste-use skill install` works offline and the
// installed skill always matches the CLI it came with.
import text from "../SKILL.md" with { type: "text" };

export const SKILL_MD: string = text;
