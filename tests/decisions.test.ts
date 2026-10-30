import { describe, expect, it } from "vitest";
import { applyHunks, commandLines, detectContractChange, detectDecision, isContractFile, namesApproved, type ReadFile } from "../src/server/collaboration/decisions.js";

const WS = "/ws";
const PKG = JSON.stringify({ name: "app", scripts: { test: "vitest" }, dependencies: { react: "^19.0.0" }, devDependencies: { vitest: "^5.0.0" } }, null, 2);

/** A workspace on paper: path -> content. */
function files(map: Record<string, string>): ReadFile {
  return (p) => map[p] ?? null;
}
const withPkg = files({ "/ws/package.json": PKG });
const detect = (tool: string, args: unknown, read: ReadFile = withPkg) => detectDecision(tool, args, WS, read);
const subjects = (tool: string, args: unknown, read?: ReadFile) => detect(tool, args, read)?.subjects ?? null;

describe("new dependencies from installer commands", () => {
  it("recognizes package managers across ecosystems, with versions and flags", () => {
    expect(subjects("bash", { command: "npm install zod" })).toEqual(["zod"]);
    expect(subjects("bash", { command: "npm i -D @types/express@^5 lodash" })).toEqual(["@types/express", "lodash"]);
    expect(subjects("bash", { command: "pnpm add -w dayjs" })).toEqual(["dayjs"]);
    expect(subjects("bash", { command: "pnpm add --filter web dayjs" })).toEqual(["dayjs"]);
    expect(subjects("bash", { command: "npm install -w web dayjs" })).toEqual(["dayjs"]);
    expect(subjects("bash", { command: "yarn add express@5" })).toEqual(["express"]);
    expect(subjects("bash", { command: "bun add hono" })).toEqual(["hono"]);
    expect(subjects("bash", { command: "pip install requests==2.32 'Flask[async]>=3'" }, files({}))).toEqual(["requests", "flask"]);
    expect(subjects("bash", { command: "python3 -m pip install Pillow" }, files({}))).toEqual(["pillow"]);
    expect(subjects("bash", { command: "uv add httpx" }, files({}))).toEqual(["httpx"]);
    expect(subjects("bash", { command: "poetry add pydantic" }, files({}))).toEqual(["pydantic"]);
    expect(subjects("bash", { command: "cargo add serde --features derive" }, files({}))).toEqual(["serde"]);
    expect(subjects("bash", { command: "go get github.com/gorilla/mux@v1.8.1" }, files({}))).toEqual(["github.com/gorilla/mux"]);
  });

  it("looks inside compound commands, shell wrappers and cd", () => {
    expect(subjects("bash", { command: "cd web && npm install zod 2>&1 | tail -5" })).toEqual(["zod"]);
    expect(subjects("bash", { command: "bash -lc 'npm install zod > install.log'" })).toEqual(["zod"]);
    expect(subjects("bash", { command: "CI=1 npm install zod; npm test" })).toEqual(["zod"]);
  });

  it("checks the nearest package.json, so a dependency new to a sub-package still counts", () => {
    const mono = files({ "/ws/package.json": PKG, "/ws/web/package.json": JSON.stringify({ dependencies: {} }) });
    expect(subjects("bash", { command: "cd web && npm install react" }, mono)).toEqual(["react"]);
    expect(subjects("bash", { command: "npm install react --prefix web" }, mono)).toEqual(["react"]);
    expect(subjects("bash", { command: "npm install react" }, mono)).toBeNull();
  });

  it("reads options placed before the subcommand (review F2)", () => {
    const mono = files({ "/ws/package.json": JSON.stringify({ dependencies: { zod: "^4" } }), "/ws/web/package.json": JSON.stringify({ dependencies: {} }) });
    expect(subjects("bash", { command: "npm --prefix web install zod" }, mono)).toEqual(["zod"]);
    expect(subjects("bash", { command: "pnpm --dir web add zod" }, mono)).toEqual(["zod"]);
    expect(subjects("bash", { command: "yarn --cwd web add zod" }, mono)).toEqual(["zod"]);
    expect(subjects("bash", { command: "npm --loglevel=warn install dayjs" })).toEqual(["dayjs"]);
    expect(subjects("bash", { command: "npm -g install typescript" })).toBeNull();
    // An option Peer does not list, with a separate value, does not hide the subcommand (review F5).
    expect(subjects("bash", { command: "npm --loglevel warn install zod" })).toEqual(["zod"]);
    expect(subjects("bash", { command: "npm --some-new-option value i zod" })).toEqual(["zod"]);
    expect(subjects("bash", { command: "npm --silent install zod" })).toEqual(["zod"]);
    expect(subjects("bash", { command: "npm --silent run build" })).toBeNull();
    expect(subjects("bash", { command: "pnpm --reporter silent add zod" })).toEqual(["zod"]);
    expect(subjects("bash", { command: "python3 -I -m pip install httpx" }, files({}))).toEqual(["httpx"]);
  });

  it("starts from the directory the runtime runs the command in (review F3)", () => {
    const mono = files({ "/ws/package.json": JSON.stringify({ dependencies: { zod: "^4" } }), "/ws/web/package.json": JSON.stringify({ dependencies: {} }) });
    // OpenCode's bash `workdir`, Codex's approval `cwd`.
    expect(subjects("bash", { command: "npm install zod", workdir: "web" }, mono)).toEqual(["zod"]);
    expect(subjects("bash", { command: "npm install zod", cwd: "/ws/web" }, mono)).toEqual(["zod"]);
    expect(subjects("bash", { command: "npm install zod", cwd: "/ws" }, mono)).toBeNull();
  });

  it("describes the action for the developer", () => {
    expect(detect("bash", { command: "npm install zod" })).toMatchObject({ kind: "dependency", ecosystem: "npm", action: "`npm install zod`" });
  });
});

describe("mechanical installs are not decisions", () => {
  it.each([
    "npm install",
    "npm ci",
    "npm install --save-dev",
    "npm install react@latest", // already a dependency: an upgrade, not a new one
    "npm install -g typescript",
    "npm install --no-save left-pad",
    "npm install ./packages/shared",
    "npx create-thing",
    "pnpm install",
    "yarn",
    "yarn global add serve",
    "pip install -r requirements.txt",
    "pip install -e .",
    "pip install --upgrade pip setuptools wheel",
    "npm run build",
    "npm ls zod",
    "echo npm install zod",
  ])("%s", (command) => {
    expect(detect("bash", { command })).toBeNull();
  });

  it("packages already declared in other manifests", () => {
    const py = files({ "/ws/requirements.txt": "requests==2.31\n# tools\nFlask_Cors\n" });
    expect(subjects("bash", { command: "pip install requests flask-cors" }, py)).toBeNull();
    expect(subjects("bash", { command: "cargo add serde" }, files({ "/ws/Cargo.toml": '[dependencies]\nserde = { version = "1" }\n' }))).toBeNull();
    expect(subjects("bash", { command: "go get github.com/gorilla/mux" }, files({ "/ws/go.mod": "module x\n\nrequire github.com/gorilla/mux v1.8.0\n" }))).toBeNull();
  });

  it("Python manifests count declarations, not comments or prose (review F4)", () => {
    expect(subjects("bash", { command: "pip install httpx" }, files({ "/ws/requirements.txt": "requests==2.31\n# Consider httpx later\n" }))).toEqual(["httpx"]);
    const pyproject = '[project]\ndescription = "A client like httpx"\ndependencies = [\n  "requests>=2",  # not httpx yet\n]\n';
    expect(subjects("bash", { command: "pip install httpx" }, files({ "/ws/pyproject.toml": pyproject }))).toEqual(["httpx"]);
    expect(subjects("bash", { command: "pip install requests" }, files({ "/ws/pyproject.toml": pyproject }))).toBeNull();
    expect(subjects("bash", { command: "pipenv install flask" }, files({ "/ws/Pipfile": '[packages]\nflask = "*"\n' }))).toBeNull();
    expect(subjects("bash", { command: "poetry add rich" }, files({ "/ws/pyproject.toml": '[tool.poetry.dependencies]\nrich = "^13"\n' }))).toBeNull();
    expect(subjects("bash", { command: "pip install attrs" }, files({ "/ws/setup.cfg": "[options]\ninstall_requires =\n    attrs>=23\n" }))).toBeNull();
    // Other fields that name a package are not declarations (review F4, repair 2).
    const meta = '[project]\nkeywords = ["httpx"]\nclassifiers = ["Framework :: rich"]\ndependencies = ["requests>=2"]\n';
    expect(subjects("bash", { command: "pip install httpx rich requests" }, files({ "/ws/pyproject.toml": meta }))).toEqual(["httpx", "rich"]);
    const groups = '[project.optional-dependencies]\ntest = [\n  "pytest>=8",\n]\n[tool.poetry.group.dev.dependencies]\nruff = "^0.6"\n';
    expect(subjects("bash", { command: "pip install pytest ruff" }, files({ "/ws/pyproject.toml": groups }))).toBeNull();
    expect(subjects("bash", { command: "pip install click" }, files({ "/ws/setup.py": 'setup(name="x", description="click-free", install_requires=[\n  "click>=8",\n])\n' }))).toBeNull();
    expect(subjects("bash", { command: "pip install rich" }, files({ "/ws/setup.py": 'setup(name="rich-demo", install_requires=["click"])\n' }))).toEqual(["rich"]);
  });

  it("asks when package.json cannot be parsed, rather than assuming the package is declared", () => {
    expect(subjects("bash", { command: "npm install zod" }, files({ "/ws/package.json": "{ broken" }))).toEqual(["zod"]);
  });
});

describe("new dependencies from manifest edits", () => {
  const added = (deps: Record<string, string>) => JSON.stringify({ ...JSON.parse(PKG), dependencies: { ...JSON.parse(PKG).dependencies, ...deps } }, null, 2);

  it("write and edit tools (OpenCode and Claude Code argument names)", () => {
    expect(subjects("write", { filePath: "package.json", content: added({ zod: "^4.0.0" }) })).toEqual(["zod"]);
    expect(subjects("write", { filePath: "/ws/package.json", content: added({ zod: "^4.0.0" }) })).toEqual(["zod"]);
    expect(subjects("edit", { filePath: "package.json", oldString: '"react": "^19.0.0"', newString: '"react": "^19.0.0",\n    "zod": "^4"' })).toEqual(["zod"]);
    expect(subjects("edit", { filePath: "/ws/package.json", old_string: '"react": "^19.0.0"', new_string: '"react": "^19.0.0",\n    "zod": "^4"' })).toEqual(["zod"]);
    // Claude Code's MultiEdit arrives as "edit" with an edits array.
    expect(subjects("edit", { filePath: "/ws/package.json", edits: [{ old_string: '"vitest": "^5.0.0"', new_string: '"vitest": "^5.0.0",\n    "tsx": "^4"' }] })).toEqual(["tsx"]);
  });

  it("a new package.json counts every dependency it declares", () => {
    expect(subjects("write", { filePath: "web/package.json", content: JSON.stringify({ dependencies: { vue: "^3" } }) }, files({}))).toEqual(["vue"]);
  });

  it("OpenCode's apply_patch format", () => {
    const patchText = ["*** Begin Patch", "*** Update File: package.json", "@@", '   "dependencies": {', '-    "react": "^19.0.0"', '+    "react": "^19.0.0",', '+    "zod": "^4.0.0"', "   },", "*** End Patch"].join("\n");
    expect(subjects("apply_patch", { patchText })).toEqual(["zod"]);
  });

  it("Codex fileChange diffs, including new files", () => {
    const diff = ["@@ -6,3 +6,4 @@", '   "dependencies": {', '-    "react": "^19.0.0"', '+    "react": "^19.0.0",', '+    "zod": "^4.0.0"', "   },"].join("\n");
    expect(subjects("apply_patch", { changes: [{ path: "/ws/package.json", kind: { type: "update", move_path: null }, diff }] })).toEqual(["zod"]);
    expect(subjects("apply_patch", { changes: [{ path: "/ws/requirements.txt", kind: { type: "add" }, diff: "httpx==0.27\n" }] }, files({}))).toEqual(["httpx"]);
  });

  it("falls back to the added lines when a patch does not apply", () => {
    const diff = ["@@ -1,1 +1,2 @@", " this context is not in the file", '+    "zod": "^4.0.0",'].join("\n");
    expect(subjects("apply_patch", { changes: [{ path: "/ws/package.json", kind: { type: "update" }, diff }] })).toEqual(["zod"]);
  });

  it("requirements files", () => {
    const read = files({ "/ws/requirements.txt": "requests==2.31\n" });
    expect(subjects("edit", { filePath: "requirements.txt", oldString: "requests==2.31\n", newString: "requests==2.31\nhttpx>=0.27  # client\n" }, read)).toEqual(["httpx"]);
  });

  it("ignores edits that add no dependency", () => {
    const pkg = JSON.parse(PKG);
    expect(detect("write", { filePath: "package.json", content: JSON.stringify({ ...pkg, scripts: { test: "vitest", lint: "eslint ." } }) })).toBeNull();
    expect(detect("write", { filePath: "package.json", content: JSON.stringify({ ...pkg, version: "2.0.0", dependencies: { react: "^19.1.0" } }) })).toBeNull();
    // Moving a dependency between sections is not a new one.
    expect(detect("write", { filePath: "package.json", content: JSON.stringify({ ...pkg, devDependencies: { vitest: "^5.0.0", react: "^19.0.0" }, dependencies: {} }) })).toBeNull();
    const read = files({ "/ws/requirements.txt": "requests==2.31\n" });
    expect(detect("edit", { filePath: "requirements.txt", oldString: "requests==2.31\n", newString: "requests==2.31\n# pinned for py3.9\n\n" }, read)).toBeNull();
    expect(detect("write", { filePath: "node_modules/x/package.json", content: JSON.stringify({ dependencies: { a: "1" } }) })).toBeNull();
    expect(detect("write", { filePath: "src/index.ts", content: "import { z } from 'zod';" })).toBeNull();
    // Other tools that happen to carry a patch-like argument.
    expect(detect("some_mcp_tool", { patchText: "*** Add File: package.json\n+{}" })).toBeNull();
  });

  it("ignores manifests outside the workspace", () => {
    expect(detect("write", { filePath: "/elsewhere/package.json", content: JSON.stringify({ dependencies: { a: "1" } }) })).toBeNull();
  });
});

describe("public API contract changes", () => {
  const contract = (tool: string, args: unknown, read: ReadFile = withPkg) => detectContractChange(tool, args, WS, read);
  const changed = (tool: string, args: unknown, read?: ReadFile) => contract(tool, args, read)?.subjects ?? null;
  const edit = (filePath: string) => ({ filePath, oldString: "a", newString: "b" });

  it("recognizes spec files by name and location", () => {
    for (const path of ["openapi.yaml", "api/openapi.yml", "openapi.json", "swagger.json", "api.swagger.json", "orders.openapi.yaml", "openapi-v2.yaml", "openapi_v2.yml", "OpenAPI.YAML", "openapi-build.yaml", "proto/notes/v1/notes.proto", "api/schema.graphqls", "schema.graphql", "api.schema.gql", "src/schema/notes.graphql", "schemas/notes.gql"]) {
      expect(changed("edit", edit(path)), path).toEqual([path]);
    }
  });

  it("does not take similar files for contracts", () => {
    for (const path of ["openapitools.json", "openapi-generator-config.yaml", "openapi.config.json", "swagger-ui.json", "swagger.md", "openapi.ts", "schema.json", "schema.ts", "src/queries/notes.graphql", "src/queries/notes.gql", "src/notes.protobuf.ts", "proto.ts"]) {
      expect(changed("edit", edit(path)), path).toBeNull();
    }
  });

  it("ignores vendored, generated, test and sample copies", () => {
    for (const path of ["node_modules/x/openapi.yaml", "vendor/a.proto", "third_party/a.proto", "dist/openapi.json", "build/schema.graphql", "target/a.proto", "src/generated/a.proto", "tests/fixtures/openapi.yaml", "test/a.proto", "__tests__/openapi.yaml", "testdata/a.proto", "examples/schema.graphql", "Vendor/a.proto"]) {
      expect(changed("edit", edit(path)), path).toBeNull();
    }
    // The folder has to be a parent: a contract named after one still counts.
    expect(changed("edit", edit("api/build.proto"))).toEqual(["api/build.proto"]);
  });

  it("every tool shape, including creating, deleting and renaming a spec", () => {
    expect(changed("write", { filePath: "/ws/openapi.yaml", content: "openapi: 3.1.0" })).toEqual(["openapi.yaml"]);
    expect(changed("edit", { file_path: "/ws/a.proto", old_string: "a", new_string: "b" })).toEqual(["a.proto"]);
    expect(changed("edit", { filePath: "a.proto", edits: [{ old_string: "a", new_string: "b" }] })).toEqual(["a.proto"]);
    expect(changed("apply_patch", { patchText: "*** Begin Patch\n*** Add File: a.proto\n+syntax\n*** Update File: openapi.yaml\n@@\n-a\n+b\n*** Delete File: schema.graphql\n*** End Patch" })).toEqual(["a.proto", "openapi.yaml", "schema.graphql"]);
    expect(changed("apply_patch", { patchText: "*** Begin Patch\n*** Update File: notes.txt\n*** Move to: a.proto\n@@\n-a\n+b\n*** End Patch" })).toEqual(["a.proto"]);
    expect(changed("apply_patch", { patchText: "*** Begin Patch\n*** Update File: a.proto\n*** Move to: notes.txt\n@@\n-a\n+b\n*** End Patch" })).toEqual(["a.proto"]);
    expect(changed("apply_patch", { changes: [{ path: "/ws/a.proto", kind: { type: "delete" }, diff: "" }, { path: "/ws/openapi.yaml", kind: { type: "add" }, diff: "x" }, { path: "/ws/notes.txt", kind: { type: "update", move_path: "/ws/b.proto" }, diff: "" }] })).toEqual(["a.proto", "openapi.yaml", "b.proto"]);
    expect(contract("apply_patch", { changes: [{ path: "/ws/a.proto", kind: { type: "update" } }, { path: "/ws/b.proto", kind: { type: "update" } }] })?.action).toBe("an edit to `a.proto`, `b.proto`");
  });

  it("ignores shell commands, reads and files outside the workspace", () => {
    expect(changed("bash", { command: "sed -i s/a/b/ openapi.yaml" })).toBeNull();
    expect(changed("read", { filePath: "openapi.yaml" })).toBeNull();
    expect(changed("edit", edit("/elsewhere/openapi.yaml"))).toBeNull();
    expect(changed("edit", edit("../openapi.yaml"))).toBeNull();
    expect(contract("write", null)).toBeNull();
  });

  describe("exports and bin in package.json", () => {
    const pkg = (fields: Record<string, unknown>) => JSON.stringify({ name: "app", ...fields }, null, 2);
    const on = (text: string) => files({ "/ws/package.json": text });
    const exports = { ".": { import: "./a.mjs", require: "./a.cjs" } };

    it("asks when a field is added, changed or removed, per field", () => {
      const was = pkg({ exports, bin: { app: "cli.js" } });
      expect(changed("write", { filePath: "package.json", content: pkg({ exports: { ".": "./b.js" }, bin: { app: "cli.js" } }) }, on(was))).toEqual(["package.json#exports"]);
      expect(changed("write", { filePath: "package.json", content: pkg({ exports, bin: "x.js" }) }, on(was))).toEqual(["package.json#bin"]);
      expect(changed("write", { filePath: "package.json", content: pkg({}) }, on(was))).toEqual(["package.json#exports", "package.json#bin"]);
      expect(changed("write", { filePath: "package.json", content: pkg({ bin: "x.js" }) }, on(pkg({})))).toEqual(["package.json#bin"]);
      expect(contract("write", { filePath: "package.json", content: pkg({ bin: "x.js" }) }, on(pkg({})))?.action).toBe("an edit to `package.json`");
    });

    it("the order of exports conditions matters; formatting does not", () => {
      const swapped = { ".": { require: "./a.cjs", import: "./a.mjs" } };
      expect(changed("write", { filePath: "package.json", content: pkg({ exports: swapped }) }, on(pkg({ exports })))).toEqual(["package.json#exports"]);
      expect(changed("write", { filePath: "package.json", content: JSON.stringify({ name: "app", exports }) }, on(pkg({ exports })))).toBeNull();
    });

    it("other edits to package.json are not contract changes", () => {
      expect(changed("write", { filePath: "package.json", content: pkg({ exports, version: "2.0.0", main: "x.js" }) }, on(pkg({ exports })))).toBeNull();
      expect(changed("edit", { filePath: "package.json", oldString: '"app"', newString: '"renamed"' }, on(pkg({ exports })))).toBeNull();
      // Words inside other fields are not the fields themselves.
      expect(changed("edit", { filePath: "package.json", oldString: '"app"', newString: '"exports"' }, on(pkg({})))).toBeNull();
    });

    it("every tool shape, a new file, a deletion, and sub-packages", () => {
      const was = pkg({ exports });
      expect(changed("edit", { filePath: "package.json", oldString: "./a.mjs", newString: "./b.mjs" }, on(was))).toEqual(["package.json#exports"]);
      expect(changed("apply_patch", { changes: [{ path: "/ws/package.json", kind: { type: "update" }, diff: '@@\n-      "import": "./a.mjs",\n+      "import": "./b.mjs",\n' }] }, on(was))).toEqual(["package.json#exports"]);
      expect(changed("apply_patch", { patchText: '*** Begin Patch\n*** Update File: package.json\n@@\n-      "import": "./a.mjs",\n+      "import": "./b.mjs",\n*** End Patch' }, on(was))).toEqual(["package.json#exports"]);
      expect(changed("write", { filePath: "web/package.json", content: pkg({ bin: "x.js" }) }, files({}))).toEqual(["web/package.json#bin"]);
      expect(changed("apply_patch", { changes: [{ path: "/ws/package.json", kind: { type: "delete" }, diff: "" }] }, on(was))).toEqual(["package.json#exports"]);
      expect(changed("apply_patch", { patchText: "*** Begin Patch\n*** Delete File: package.json\n*** End Patch" }, on(was))).toEqual(["package.json#exports"]);
      expect(changed("apply_patch", { changes: [{ path: "/ws/package.json", kind: { type: "delete" }, diff: "" }] }, on(pkg({})))).toBeNull();
    });

    it("asks about a field the text mentions when it cannot tell what changes", () => {
      // Invalid JSON after the edit.
      expect(changed("write", { filePath: "package.json", content: '{ "exports": "./a.js", ' }, on(pkg({})))).toEqual(["package.json#exports"]);
      expect(changed("write", { filePath: "package.json", content: '{ "name": ' }, on(pkg({})))).toBeNull();
      // A patch Peer cannot apply, that adds or sits next to the field.
      expect(changed("apply_patch", { changes: [{ path: "/ws/package.json", kind: { type: "update" }, diff: '@@\n-nothing like this\n+  "bin": "x.js",\n' }] }, on(pkg({})))).toEqual(["package.json#bin"]);
      expect(changed("apply_patch", { changes: [{ path: "/ws/package.json", kind: { type: "update" }, diff: "@@\n-nothing like this\n+other\n" }] }, on(pkg({ exports })))).toEqual(["package.json#exports"]);
    });

    describe("patches Peer can't place with certainty (review F1)", () => {
      const repeated = JSON.stringify({ name: "app", imports: { "#api": { default: "./old.js" } }, exports: { ".": { default: "./old.js" } } }, null, 2);
      const change = ['-      "default": "./old.js"', '+      "default": "./new.js"'];

      it("asks when a hunk's old lines occur more than once, on Codex and OpenCode", () => {
        // Line 9 is in exports; the first match, in imports, is not what the patch changes.
        const diff = ["@@ -9,1 +9,1 @@", ...change, ""].join("\n");
        expect(changed("apply_patch", { changes: [{ path: "/ws/package.json", kind: { type: "update" }, diff }] }, on(repeated))).toEqual(["package.json#exports"]);
        expect(changed("apply_patch", { patchText: ['*** Begin Patch', '*** Update File: package.json', '@@ "exports": {', ...change, "*** End Patch"].join("\n") }, on(repeated))).toEqual(["package.json#exports"]);
      });

      it("recognizes a field name spelled with JSON escapes (review F2)", () => {
        const escaped = repeated.replace('"exports"', '"exp\\u006frts"');
        expect(Object.keys(JSON.parse(escaped))).toContain("exports");
        const diff = ["@@ -9,1 +9,1 @@", ...change, ""].join("\n");
        expect(changed("apply_patch", { changes: [{ path: "/ws/package.json", kind: { type: "update" }, diff }] }, on(escaped))).toEqual(["package.json#exports"]);
        // Added by the patch, or in content that doesn't parse.
        expect(changed("apply_patch", { changes: [{ path: "/ws/package.json", kind: { type: "update" }, diff: '@@\n-nothing like this\n+  "b\\u0069n": "x.js",\n' }] }, on(pkg({})))).toEqual(["package.json#bin"]);
        expect(changed("write", { filePath: "package.json", content: '{ "b\\u0069n": "x.js", ' }, on(pkg({})))).toEqual(["package.json#bin"]);
        // When both sides parse, the comparison already sees through the escape.
        expect(changed("write", { filePath: "package.json", content: '{ "name": "app", "b\\u0069n": "x.js" }' }, on(pkg({})))).toEqual(["package.json#bin"]);
      });

      it("still compares exactly when the hunk's place is unique", () => {
        const unique = JSON.stringify({ name: "app", imports: { "#api": { default: "./old.js" } }, exports: { ".": { default: "./other.js" } } }, null, 2);
        expect(changed("apply_patch", { changes: [{ path: "/ws/package.json", kind: { type: "update" }, diff: ["@@", ...change, ""].join("\n") }] }, on(unique))).toBeNull();
      });

      it("repeated lines in a package without contract fields don't ask", () => {
        const plain = JSON.stringify({ name: "app", scripts: { a: "x" }, config: { a: "x" } }, null, 2);
        expect(changed("apply_patch", { changes: [{ path: "/ws/package.json", kind: { type: "update" }, diff: '@@\n-    "a": "x"\n+    "a": "y"\n' }] }, on(plain))).toBeNull();
      });
    });

    it("an edit whose old text isn't literally in the file may still apply: asks about a field it could touch", () => {
      // OpenCode's edit tool matches loosely (whitespace, indentation).
      const compact = '{"name":"app","exports":{".":"./a.js"}}';
      expect(changed("edit", { filePath: "package.json", oldString: '"exports": { ".": "./a.js" }', newString: '"exports": { ".": "./b.js" }' }, on(compact))).toEqual(["package.json#exports"]);
      expect(changed("edit", { filePath: "package.json", oldString: "no such text", newString: '"bin": "x.js"' }, on(pkg({})))).toEqual(["package.json#bin"]);
      expect(changed("edit", { filePath: "package.json", oldString: "no such text", newString: "other" }, on(pkg({})))).toBeNull();
    });

    it("adding a file over an existing package.json compares with what is there", () => {
      const was = pkg({ exports });
      expect(changed("apply_patch", { changes: [{ path: "/ws/package.json", kind: { type: "add" }, diff: pkg({}) }] }, on(was))).toEqual(["package.json#exports"]);
      const same = pkg({ exports }).split("\n").map((l) => `+${l}`).join("\n");
      expect(changed("apply_patch", { patchText: `*** Begin Patch\n*** Add File: package.json\n${same}\n*** End Patch` }, on(was))).toBeNull();
    });

    it("ignores copies under node_modules, vendor and test folders", () => {
      for (const path of ["node_modules/x/package.json", "vendor/x/package.json", "tests/fixtures/app/package.json"]) {
        expect(changed("write", { filePath: path, content: pkg({ bin: "x.js" }) }, files({})), path).toBeNull();
      }
    });
  });

  it("is a separate detection from new dependencies", () => {
    const both = JSON.stringify({ ...JSON.parse(PKG), bin: "x.js", dependencies: { ...JSON.parse(PKG).dependencies, zod: "^4" } });
    expect(detect("write", { filePath: "package.json", content: both })?.kind).toBe("dependency");
    expect(contract("write", { filePath: "package.json", content: both })).toMatchObject({ kind: "contract", ecosystem: "api", subjects: ["package.json#bin"] });
    expect(detect("edit", edit("openapi.yaml"))).toBeNull();
    expect(isContractFile("a.proto")).toBe(true);
  });
});

describe("helpers", () => {
  it("splits shell command lines, respecting quotes and dropping redirections", () => {
    expect(commandLines(`npm i "a b" && echo 'x;y' > out.txt 2>&1 | tee log`)).toEqual([["npm", "i", "a b"], ["echo", "x;y"], ["tee", "log"]]);
  });

  it("applies hunks by context, ignoring line numbers", () => {
    expect(applyHunks("a\nb\nc\n", ["@@ -9,2 +9,2 @@", " b", "-c", "+C"])).toBe("a\nb\nC\n");
    expect(applyHunks("a\nb\n", ["@@", " missing", "+x"])).toBeNull();
  });

  it("reads the developer's words as approval only without negation or an open question", () => {
    // Unambiguous requests: an imperative sentence whose object is unmistakably a package.
    expect(namesApproved("Add `zod` for request validation.", "zod")).toBe(true);
    expect(namesApproved("Use @tanstack/query, please", "@tanstack/query")).toBe(true);
    expect(namesApproved("Fix the button. Then add date-fns.", "date-fns")).toBe(true);
    expect(namesApproved("Please install the pino library.", "pino")).toBe(true);
    expect(namesApproved('Replace moment with "dayjs".', "dayjs")).toBe(true);
    expect(namesApproved("Replace moment with `dayjs`.", "moment")).toBe(false);
    expect(namesApproved("Add `zod` and `pino` to the API.", "pino")).toBe(true);
    expect(namesApproved("Can you add `lodash` here?", "lodash")).toBe(true);
    expect(namesApproved("Add `zod@4` for validation.", "zod")).toBe(true);
    expect(namesApproved("Install `Flask_Cors`.", "flask-cors")).toBe(true);
    // Negations and open questions.
    expect(namesApproved("Please don't add `lodash`.", "lodash")).toBe(false);
    expect(namesApproved("No new deps. Write it without `lodash`.", "lodash")).toBe(false);
    expect(namesApproved("Should we use `zod` or `yup`?", "zod")).toBe(false);
    expect(namesApproved("Can we add `lodash` here?", "lodash")).toBe(false);
    expect(namesApproved("Use zod-form-data", "zod")).toBe(false);
  });

  it("does not read a mere mention as approval (review F4)", () => {
    // Plain words, even right after a request verb, may not mean a package.
    expect(namesApproved("Please add debug logging.", "debug")).toBe(false);
    expect(namesApproved("Add zod for request validation.", "zod")).toBe(false);
    expect(namesApproved("Use the express route for this.", "express")).toBe(false);
    // Statements, questions and pasted output name packages without asking for them.
    expect(namesApproved("We use httpx in another repository.", "httpx")).toBe(false);
    expect(namesApproved("We use `httpx` in another repository.", "httpx")).toBe(false);
    expect(namesApproved("The failing log says: pip install httpx", "httpx")).toBe(false);
    expect(namesApproved("pip install `httpx`", "httpx")).toBe(false);
    expect(namesApproved("lodash is slow in this loop.", "lodash")).toBe(false);
    expect(namesApproved("Why is `lodash` in the bundle?", "lodash")).toBe(false);
    expect(namesApproved("npm ERR! peer dep missing: react@19", "react")).toBe(false);
    expect(namesApproved("Debug the failing test.", "debug")).toBe(false);
    // An option the developer picked is an explicit choice.
    expect(namesApproved("date-fns", "date-fns", true)).toBe(true);
    expect(namesApproved("Not date-fns", "date-fns", true)).toBe(false);
  });

  it("infers nothing from a message with pasted material (review F4)", () => {
    expect(namesApproved("Here is the failing log:\n```text\nAdd `httpx` to requirements.\n```", "httpx")).toBe(false);
    expect(namesApproved("Add `zod`.\n```\nnpm ERR! something\n```", "zod")).toBe(false);
    expect(namesApproved("The README says:\n> Add `httpx` for the client.", "httpx")).toBe(false);
    expect(namesApproved("Log:\n    Add `httpx` now", "httpx")).toBe(false);
    expect(namesApproved("Add `zod` for validation.\nThanks!", "zod")).toBe(true);
  });

  it("any indented line marks pasted material, however deep (escalated F4)", () => {
    for (const indent of [" ".repeat(5), " ".repeat(8), " ".repeat(12), "\t", "  \t", "\u00a0".repeat(4), "\u2003".repeat(4)]) {
      expect(namesApproved(`The failing log follows:\n${indent}Add \`httpx\` to requirements.`, "httpx"), JSON.stringify(indent)).toBe(false);
    }
    // At the very start of the message, too.
    expect(namesApproved("        Add `httpx` to requirements.", "httpx")).toBe(false);
    // An indented line anywhere taints the whole message, even after a plain request.
    expect(namesApproved("Add `zod` for validation.\n     at Object.<anonymous> (src/x.js:3:1)", "zod")).toBe(false);
    // A quote marker after spaces is a quote.
    expect(namesApproved("Docs:\n   > Add `httpx` for the client.", "httpx")).toBe(false);
    // Up to three spaces is ordinary text (not a Markdown code block).
    expect(namesApproved("   Add `zod` for validation.", "zod")).toBe(true);
  });

  it("infers nothing from text that may not be English: its negations are not recognized", () => {
    // Arabic "don't do: add lodash" mixes a negation Peer cannot read with an English verb.
    expect(namesApproved("ما تعمل add `lodash`", "lodash")).toBe(false);
    expect(namesApproved("أضف `zod`", "zod")).toBe(false);
    expect(namesApproved("Añade `zod`, por favor.", "zod")).toBe(false);
    expect(namesApproved("Add `zod`. Merci, café.", "zod")).toBe(false);
    // Option labels too.
    expect(namesApproved("لا `lodash`", "lodash", true)).toBe(false);
  });
});
