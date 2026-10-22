import { describe, expect, it } from "vitest";
import { isReadOnlyCommand, isReadOnlyTool } from "../src/server/collaboration/tool-classification.js";

describe("tool classification", () => {
  it("treats exploration tools as read-only and edits as mutating", () => {
    for (const t of ["read", "glob", "grep", "webfetch", "todowrite", "peer_checkpoint", "task"]) expect(isReadOnlyTool(t, {})).toBe(true);
    for (const t of ["edit", "write", "apply_patch", "some_mcp_tool"]) expect(isReadOnlyTool(t, {})).toBe(false);
  });

  it("allows read-only shell commands", () => {
    for (const cmd of [
      "ls -la",
      "cat src/server.js",
      "git status",
      "git log --oneline -5",
      "git diff HEAD~1",
      "grep -rn rate src | head -20",
      "cd src && ls",
      "find . -name '*.js'",
      "npm ls",
      "git branch -a",
      "sed -n '1,20p' file.js",
      "sed -n 5p a.txt",
      "node --version 2>&1 >/dev/null || true",
    ]) {
      expect(isReadOnlyCommand(cmd), cmd).toBe(cmd.startsWith("node") ? false : true);
    }
  });

  it("treats anything that may write or execute as mutating", () => {
    for (const cmd of [
      "echo hi > file.txt",
      "cat a >> b",
      "rm -rf dist",
      "npm install express",
      "node script.js",
      "git commit -m x",
      "git branch feature",
      "git tag v1",
      "git remote add origin x",
      "git config user.name x",
      "sed -i 's/a/b/' f",
      "sed 'w victim.txt' input.txt",
      "sed -n '1p;w out' f",
      "sed 's/x/date/e' f",
      "rg --pre ./script pattern",
      "rg --pre-glob '*.x' --pre sh p",
      "find . -fprint0 out",
      "tree -o out.txt",
      "git diff --output=patch.txt",
      "git grep -O foo",
      "git log --ext-diff",
      "less file.txt",
      "file -C -m magic",
      "find . -delete",
      "find . -exec rm {} \\;",
      "ls && touch x",
      "ls; python3 -c 'print(1)'",
      "echo $(rm -rf /)",
      "sort -o out.txt in.txt",
      "env rm x",
      "sleep 10 &",
      "",
    ]) {
      expect(isReadOnlyCommand(cmd), cmd).toBe(false);
    }
  });

  it("treats uniq with an output operand as mutating", () => {
    for (const cmd of ["uniq", "uniq file.txt", "uniq -c file.txt", "uniq -f 1 file.txt", "sort f | uniq -c"]) expect(isReadOnlyCommand(cmd), cmd).toBe(true);
    for (const cmd of ["uniq in.txt out.txt", "uniq -c in.txt out.txt", "uniq -f 1 in.txt out.txt", "uniq in.txt -- out.txt"]) expect(isReadOnlyCommand(cmd), cmd).toBe(false);
  });

  it("treats go env -w / -u as mutating", () => {
    for (const cmd of ["go env", "go env GOPATH", "go env -json"]) expect(isReadOnlyCommand(cmd), cmd).toBe(true);
    for (const cmd of ["go env -w GOFLAGS=-mod=mod", "go env -u GOFLAGS"]) expect(isReadOnlyCommand(cmd), cmd).toBe(false);
  });

  it("sees through quoted, escaped and expanded flags and operands", () => {
    for (const cmd of [
      "go env '-w' GOFLAGS=-mod=mod",
      'go env "-w" X',
      "go env \\-w X",
      "go env --w GOFLAGS=-mod=mod",
      "go env --u GOFLAGS",
      "go env -'w' X",
      "uniq {in,out}",
      "uniq *.txt",
      "uniq $F",
      'uniq "$F"',
      "sort '-o' out in",
      "sort $OPTS in",
      "find . '-delete'",
      "find . -name *.js",
      "git diff '--output=x'",
      "git log $ARGS",
      // BSD uniq stops parsing options at the first operand: this writes a file named "-c".
      "uniq input -c",
      // ...including "--", which BSD uniq then treats as the output file name.
      "uniq input --",
      // After `--`, "--get" is a value being written, not the getter flag.
      "git config -- user.name '--get'",
      "git config user.name --get",
    ]) {
      expect(isReadOnlyCommand(cmd), cmd).toBe(false);
    }
    for (const cmd of ["find . -name '*.js'", 'grep -rn "rate limit" src', "uniq 'my file.txt'", "git log --format='%h %s'", "git diff HEAD~1", "uniq -c input", "uniq -- input", "FOO=bar uniq -f 1 input", "LC_ALL=C git config --get user.name", "git config --get user.name", "git config '--get' user.name"]) expect(isReadOnlyCommand(cmd), cmd).toBe(true);
  });

  it("classifies bash tool calls by their command", () => {
    expect(isReadOnlyTool("bash", { command: "git status" })).toBe(true);
    expect(isReadOnlyTool("bash", { command: "npm test" })).toBe(false);
    expect(isReadOnlyTool("bash", {})).toBe(false);
  });
});
