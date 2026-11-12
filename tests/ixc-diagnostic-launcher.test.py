"""Real exec test with a synthetic marker; no network or business input."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
LAUNCHER = ROOT / "scripts" / "launch-ixc-diagnostic.py"
MARKER = "SYNTHETIC-NOT-A-NETWORK-SECRET-LAUNCHER"

# CPython audit observes the real execve; it neither replaces nor simulates it.
AUDITOR = r'''
import json, os, runpy, sys
launcher, node = sys.argv[1:]
marker = os.environ["IXC_DIRECT_AUTHORIZATION"]
def observe(event, details):
    if event != "os.exec": return
    path, argv, env = details
    expected = {"PATH", "NODE_ENV", "IXC_DIRECT_AUTHORIZATION", "IXC_DIRECT_READ_APPROVED"}
    if set(env) != expected or env["IXC_DIRECT_AUTHORIZATION"] != marker:
        raise RuntimeError("ENVIRONMENT_NOT_PRESERVED")
    if any(marker in str(arg) for arg in argv) or marker in str(path):
        raise RuntimeError("AUTHORIZATION_IN_ARGV")
    print(json.dumps({"event":"launcher.exec", "argvOpaque":True,
                      "envKeys":sorted(env), "filtered":True}), flush=True)
sys.addaudithook(observe)
sys.argv = [launcher, "--node", node]
runpy.run_path(launcher, run_name="__main__")
'''


class LauncherTest(unittest.TestCase):
    def test_actual_exec_preserves_environment_without_argv_or_output_disclosure(self):
        node = shutil.which("node")
        self.assertTrue(node is not None, "NODE_NOT_AVAILABLE")
        env = {"PATH": str(Path(node).parent) + ":/usr/local/bin:/usr/bin:/bin",
               "IXC_DIRECT_AUTHORIZATION": MARKER, "IXC_DIRECT_READ_APPROVED": "false",
               "NODE_OPTIONS": "--synthetic-invalid-option-must-be-removed",
               "NODE_TLS_REJECT_UNAUTHORIZED": "0"}
        args = [sys.executable, "-I", "-c", AUDITOR, str(LAUNCHER), node]
        self.assertTrue(all(MARKER not in arg for arg in args), "MARKER_IN_BOOTSTRAP_ARGV")
        result = subprocess.run(args, env=env, input="", text=True, capture_output=True, timeout=5)
        self.assertTrue(result.returncode == 78 and result.stderr == "", "UNEXPECTED_PROCESS_RESULT")
        self.assertTrue(MARKER not in result.stdout + result.stderr, "MARKER_DISCLOSED")
        lines = result.stdout.splitlines()
        self.assertTrue(len(lines) == 2, "UNEXPECTED_OUTPUT")
        audit, cli = map(json.loads, lines)
        self.assertTrue(audit.get("argvOpaque") and audit.get("filtered"), "EXEC_NOT_OBSERVED")
        self.assertTrue(cli == {"event":"ixc.directDiagnostic", "version":1,
                               "outcome":"refused", "category":"configuration"}, "CLI_NOT_REACHED")

    def test_nonisolated_invocation_refuses_before_node(self):
        result = subprocess.run([sys.executable, str(LAUNCHER), "--node", shutil.which("node")],
                                env={"PATH":"/usr/local/bin:/usr/bin:/bin"},
                                input="", text=True, capture_output=True, timeout=5)
        self.assertTrue(result.returncode == 78 and result.stderr == "", "LAUNCHER_DID_NOT_REFUSE")
        data = json.loads(result.stdout)
        self.assertTrue(data.get("category") == "launcher-configuration", "WRONG_REFUSAL")


if __name__ == "__main__":
    unittest.main()
