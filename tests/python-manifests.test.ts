import { describe, expect, it } from "vitest";
import { detectDecision, type ReadFile } from "../src/server/collaboration/decisions.js";
import { parseToml, pipfileDependencies, pyprojectDependencies, setupCfgDependencies, setupPyDependencies } from "../src/server/collaboration/python-manifests.js";

const set = (s: Set<string> | null) => (s === null ? null : [...s].sort());
const pip = (pkg: string, manifest: Record<string, string>) => {
  const read: ReadFile = (p) => manifest[p.replace("/ws/", "")] ?? null;
  return detectDecision("bash", { command: `pip install ${pkg}` }, "/ws", read)?.subjects ?? null;
};

describe("setup.py is tokenized, never executed (escalated F4)", () => {
  it("ignores commented-out declarations", () => {
    const src = 'from setuptools import setup\n# install_requires=["httpx"],\nsetup(\n    name="demo",  # uses httpx later\n    install_requires=["requests>=2"],\n)\n';
    expect(set(setupPyDependencies(src))).toEqual(["requests"]);
    expect(pip("httpx", { "setup.py": src })).toEqual(["httpx"]);
  });

  it("extras group names are not packages; their requirement lists are", () => {
    const src = 'setup(install_requires=[], extras_require={"httpx": ["requests"], "dev": ["pytest>=8", "ruff"]})\n';
    expect(set(setupPyDependencies(src))).toEqual(["pytest", "requests", "ruff"]);
    expect(pip("httpx", { "setup.py": src })).toEqual(["httpx"]);
    expect(pip("ruff", { "setup.py": src })).toBeNull();
  });

  it("follows a module-level name bound to a literal, and strings that only contain a name", () => {
    const src = 'REQUIRES = [\n    "click>=8",  # cli\n    "httpx[http2]>=0.27",\n    "rich",\n]\nsetup(name="x", description="faster than requests", install_requires=REQUIRES)\n';
    expect(set(setupPyDependencies(src))).toEqual(["click", "httpx", "rich"]);
  });

  it("anything it cannot understand declares nothing, so Peer asks", () => {
    for (const src of [
      "setup(install_requires=open('requirements.txt').read().splitlines())\n",
      "setup(install_requires=BASE + EXTRA)\n",
      "setup(install_requires=[dep for dep in DEPS])\n",
      'setup(install_requires=[f"httpx>={V}"])\n',
      'setup(install_requires=["httpx"\n', // unterminated
    ]) {
      expect(pip("httpx", { "setup.py": src }), src).toEqual(["httpx"]);
    }
    // A name bound twice is ambiguous.
    expect(setupPyDependencies('DEPS = ["httpx"]\nif x:\n    DEPS = ["requests"]\nsetup(install_requires=DEPS)\n')).toBeNull();
  });
});

describe("setup.py: only complete literals in code that runs (review F1, F2)", () => {
  it("a literal that is only part of an expression is not understood", () => {
    expect(pip("httpx", { "setup.py": 'setup(install_requires=["httpx"] if False else [])\n' })).toEqual(["httpx"]);
    expect(pip("httpx", { "setup.py": 'setup(install_requires=["httpx"] + extra)\n' })).toEqual(["httpx"]);
    expect(pip("httpx", { "setup.py": 'DEPS = ["httpx"] if PY3 else []\nsetup(install_requires=DEPS)\n' })).toEqual(["httpx"]);
  });

  it("adjacent string literals are one string, as in Python", () => {
    expect(set(setupPyDependencies('setup(install_requires=["httpx" "-sse"])\n'))).toEqual(["httpx-sse"]);
    expect(pip("httpx", { "setup.py": 'setup(install_requires=["httpx" "-sse"])\n' })).toEqual(["httpx"]);
  });

  it("declarations in functions or classes that may never run declare nothing", () => {
    const src = 'DEPS = []\ndef unused():\n    LOCAL = ["httpx"]\n    setup(install_requires=LOCAL)\nclass Cmd:\n    def run(self):\n        setup(install_requires=["httpx"])\nsetup(install_requires=DEPS)\n';
    expect(set(setupPyDependencies(src))).toEqual([]);
    expect(pip("httpx", { "setup.py": src })).toEqual(["httpx"]);
  });

  it("the direct body of an exact top-level main guard runs; nothing else under it (review F2)", () => {
    expect(set(setupPyDependencies('if __name__ == "__main__":\n    setup(install_requires=["rich"])\n'))).toEqual(["rich"]);
    expect(set(setupPyDependencies("if '__main__' == __name__:\n    setup(install_requires=['rich'])\n"))).toEqual(["rich"]);
    for (const src of [
      'if __name__ != "__main__":\n    setup(install_requires=["httpx"])\n',
      'if __name__ == "__main__" and False:\n    setup(install_requires=["httpx"])\n',
      'if __name__ == "__main__":\n    def unused():\n        setup(install_requires=["httpx"])\n    pass\n',
      'if __name__ == "__main__":\n    if False:\n        setup(install_requires=["httpx"])\n',
      'if False:\n    setup(install_requires=["httpx"])\n',
    ]) {
      expect(pip("httpx", { "setup.py": src }), src).toEqual(["httpx"]);
    }
  });

  it("setup() must be the whole statement, so it certainly runs", () => {
    for (const src of ['setup(install_requires=["httpx"]) if False else None\n', 'False and setup(install_requires=["httpx"])\n', 'run = lambda: setup(install_requires=["httpx"])\n', 'x = [setup(install_requires=["httpx"])][:0]\n']) {
      expect(pip("httpx", { "setup.py": src }), src).toEqual(["httpx"]);
    }
    expect(set(setupPyDependencies('import setuptools\nsetuptools.setup(\n    install_requires=["rich"],\n)\n'))).toEqual(["rich"]);
  });

  it("a bound name changed anywhere is not trusted", () => {
    for (const change of ['DEPS.append("x")', 'DEPS += ["x"]', "DEPS = DEPS + EXTRA", "for DEPS in []: pass", "del DEPS[0]"]) {
      expect(setupPyDependencies(`DEPS = ["httpx"]\n${change}\nsetup(install_requires=DEPS)\n`), change).toBeNull();
    }
    // Passing a name of the same spelling as a keyword is not a second binding.
    expect(set(setupPyDependencies('install_requires = ["httpx"]\nsetup(install_requires=install_requires)\n'))).toEqual(["httpx"]);
  });

  it("a function named setup is not a call", () => {
    expect(setupPyDependencies('def setup(install_requires=["httpx"]):\n    pass\n')).toEqual(new Set());
  });
});

describe("TOML manifests are parsed, not pattern-matched (escalated F6)", () => {
  it("a bracket inside a quoted requirement does not end a multi-line array", () => {
    const src = '[project]\nname = "demo"\ndependencies = [\n  "httpx[http2]>=0.27",  # extras\n  "requests>=2",\n  \'rich ; python_version >= "3.9"\',\n]\n';
    expect(set(pyprojectDependencies(src))).toEqual(["httpx", "requests", "rich"]);
    expect(pip("requests", { "pyproject.toml": src })).toBeNull();
  });

  it("reads PEP 621, PEP 735, build-system, Poetry, uv and PDM declarations and nothing else", () => {
    const src = [
      "[build-system]",
      'requires = ["hatchling"]',
      "[project]",
      'keywords = ["httpx"]',
      'description = "like requests"',
      'dependencies = ["click"]',
      "[project.optional-dependencies]",
      'test = ["pytest"]',
      "[dependency-groups]",
      'lint = ["ruff", { include-group = "test" }]',
      "[tool.poetry.dependencies]",
      'python = "^3.11"',
      'Flask_Cors = { version = "^4", extras = ["x"] }',
      "[tool.poetry.group.docs.dependencies]",
      'mkdocs = "*"',
      "[tool.uv]",
      'dev-dependencies = ["mypy"]',
      "[tool.pdm.dev-dependencies]",
      'bench = ["pyperf"]',
      "[[tool.mypy.overrides]]",
      'module = ["httpx.*"]',
    ].join("\n");
    expect(set(pyprojectDependencies(src))).toEqual(["click", "flask-cors", "hatchling", "mkdocs", "mypy", "pyperf", "pytest", "ruff"]);
  });

  it("malformed TOML declares nothing, even if a dependency array is valid (review F3)", () => {
    const bad = [
      '[project]\ndependencies = ["httpx"]\nversion = this-is-not-toml\n',
      '[project]\ndependencies = ["httpx"]\ndependencies = ["requests"]\n',
      '[project]\ndependencies = ["httpx"]\n[project]\nname = "x"\n',
      '[project]\ndependencies = ["httpx"]\nname = "a\\qb"\n',
      'project = { name = "x" }\n[project.dependencies]\nhttpx = "*"\n',
      '[project]\ndependencies = ["httpx"]\nurls = [1, 2]\n[[project.urls]]\n',
    ];
    for (const src of bad) {
      expect(parseToml(src), src).toBeNull();
      expect(pip("httpx", { "pyproject.toml": src }), src).toEqual(["httpx"]);
    }
  });

  it("rejects impossible values and forbidden characters (review F3, F5)", () => {
    const base = '[project]\ndependencies = ["httpx"]\n';
    for (const extra of [
      "release = 2026-99-99",
      "release = 2026-02-30",
      "release = 2025-02-29",
      "at = 2026-01-01T25:00:00Z",
      "at = 2026-01-01T10:00:00+24:00",
      "n = 9223372036854775808",
      'name = "a\u0001b"',
      "name = 'a\u0001b'",
      'name = "\\U00110000"',
      'name = "\\uD800"',
      "# comment with \u0007 bell",
    ]) {
      const src = base + extra + "\n";
      expect(parseToml(src), extra).toBeNull();
      expect(pip("httpx", { "pyproject.toml": src }), extra).toEqual(["httpx"]);
    }
    expect(parseToml(base + "leap = 2024-02-29\nn = -9223372036854775808\n")).not.toBeNull();
  });

  it("a line-ending backslash trims only spaces, tabs and newlines (escalated F3)", () => {
    const base = '[project]\ndependencies = ["httpx"]\n';
    // Control characters after the continuation are not swallowed: the document is invalid, so Peer asks.
    for (const after of ["\u000b", "\f", "\r"]) {
      const src = `${base}description = """text\\\n${after}continued"""\n`;
      expect(parseToml(src), JSON.stringify(after)).toBeNull();
      expect(pip("httpx", { "pyproject.toml": src }), JSON.stringify(after)).toEqual(["httpx"]);
    }
    // Other Unicode whitespace is content, not TOML whitespace: it stays in the value.
    const nbsp = parseToml('description = """text\\\n\u00a0continued"""\n');
    expect(nbsp?.description).toBe("text\u00a0continued");
    // Valid continuations still trim spaces, tabs, LF and CRLF.
    expect(parseToml('d = """a \\\n \t\n  b"""\n')?.d).toBe("a b");
    expect(parseToml('d = """a \\\r\n\r\n  b"""\r\n')?.d).toBe("a b");
    expect(parseToml('d = """a\\ \t\n b"""\n')?.d).toBe("ab");
  });

  it("accepts valid scalars, dotted keys and multi-line strings", () => {
    const src = 'title = "x"\nn = 1_000\nf = -3.5e2\nok = true\nwhen = 1979-05-27T07:32:00Z\nday = 1979-05-27\nx.y = 1\ntext = """\nline "one" ""\n"""\n[project]\ndependencies = ["httpx"]\n';
    expect(parseToml(src)).not.toBeNull();
    expect(set(pyprojectDependencies(src))).toEqual(["httpx"]);
  });

  it("invalid TOML declares nothing, so Peer asks", () => {
    expect(parseToml('[project]\ndependencies = ["httpx"\n')).toBeNull();
    expect(pip("httpx", { "pyproject.toml": '[project]\ndependencies = ["httpx",\n' })).toEqual(["httpx"]);
  });

  it("Pipfile packages and dev-packages", () => {
    expect(set(pipfileDependencies('[[source]]\nurl = "https://pypi.org/simple"\n[packages]\nflask = "*"\n[dev-packages]\n"pytest-cov" = "*"\n[requires]\npython_version = "3.12"\n'))).toEqual(["flask", "pytest-cov"]);
  });
});

describe("setup.cfg", () => {
  it("reads install_requires and extras values, skips comments and group names", () => {
    const src = "[metadata]\nname = demo\nkeywords = httpx\n[options]\ninstall_requires =\n    attrs>=23\n    # httpx\n    click ; python_version>'3.8'\n[options.extras_require]\nhttpx =\n    requests\n";
    expect(set(setupCfgDependencies(src))).toEqual(["attrs", "click", "requests"]);
    expect(pip("httpx", { "setup.cfg": src })).toEqual(["httpx"]);
  });

  it("does not follow file: indirection; that declares nothing", () => {
    expect(setupCfgDependencies("[options]\ninstall_requires = file: requirements.in\n")).toBeNull();
  });
});
