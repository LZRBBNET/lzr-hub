#!/usr/bin/python3
"""Pass only the approved environment keys to Node, never their values in argv."""
import json
import os
from pathlib import Path
import sys


def refuse():
    print(json.dumps({"event": "ixc.directDiagnostic", "version": 1,
                      "outcome": "refused", "category": "launcher-configuration"}))
    return 78


def main():
    if not sys.flags.isolated or len(sys.argv) != 3 or sys.argv[1] != "--node":
        return refuse()
    try:
        node = Path(sys.argv[2])
        if not node.is_absolute() or node.name != "node" or not node.is_file() or not os.access(node, os.X_OK):
            return refuse()
        script = Path(__file__).resolve().with_name("diagnose-ixc-direct.mjs")
        clean = {"PATH": str(node.parent) + ":/usr/local/bin:/usr/bin:/bin", "NODE_ENV": "production"}
        for key in ("HTTPS_PROXY", "CODEX_PROXY_CERT", "IXC_DIRECT_AUTHORIZATION", "IXC_DIRECT_READ_APPROVED"):
            if key in os.environ:
                clean[key] = os.environ[key]
        os.execve(str(node), [str(node), "--experimental-strip-types", str(script)], clean)
    except (OSError, ValueError):
        return refuse()


if __name__ == "__main__":
    sys.exit(main())
