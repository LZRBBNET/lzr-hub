"""Local YAML lint and strict review policy, NOT the full Render schema/API."""
import json
import sys
from pathlib import Path

import yaml


class UniqueLoader(yaml.SafeLoader):
    pass


def mapping(loader, node, deep=False):
    result = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in result:
            raise ValueError("duplicate YAML key")
        result[key] = loader.construct_object(value_node, deep=deep)
    return result


UniqueLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, mapping)

FLAGS = {
    "NODE_ENV": "production", "NODE_VERSION": "24.22.1", "LZR_ENV": "staging",
    "NEXT_PUBLIC_LZR_ENV": "staging", "LZR_RUNTIME_MODE": "mock", "FEATURE_AUTH": "true",
    "PILOT_MODE": "disabled", "IXC_MODE": "disabled", "IXC_TRANSPORT": "disabled",
    "FEATURE_IXC_FULL_BASE": "false", "FEATURE_SYNTHETIC_INVOICES": "true",
    "DEMO_DATASET": "isolated-invoices-v1", "SYNTHETIC_WEB_DEMO": "true",
    "SYNTHETIC_INIT_ENABLED": "false", "SYNTHETIC_DATABASE_CONFIRMATION": "isolated-synthetic-postgres-v1",
}
for flag in ("FEATURE_IXC_WRITE", "IXC_WRITE_ENABLED", "FEATURE_QUEUES", "FEATURE_META_WHATSAPP",
             "FEATURE_N8N_CHANNEL", "FEATURE_N8N_AUTOREPLY", "FEATURE_ATTENDANT_REPLY",
             "FEATURE_EVOLUTION", "FEATURE_CHATWOOT", "FEATURE_LANGFUSE", "FEATURE_LLM_INTENT",
             "FEATURE_COPILOT_LLM", "FEATURE_TELEGRAM_ALERTS", "FEATURE_PGVECTOR",
             "FEATURE_AGENT_HOMOLOGATION_PROFILES"):
    FLAGS[flag] = "false"


def require(condition):
    if not condition:
        raise ValueError("synthetic Blueprint policy refused")


def validate(doc):
    require(isinstance(doc, dict) and set(doc) == {"services", "databases", "previews"})
    require(doc["previews"] == {"generation": "off"})
    require(isinstance(doc["services"], list) and len(doc["services"]) == 1)
    require(isinstance(doc["databases"], list) and len(doc["databases"]) == 1)
    service, database = doc["services"][0], doc["databases"][0]
    expected = {
        "type": "web", "name": "lzr-synthetic-review-web-20261105", "runtime": "node", "plan": "free",
        "region": "oregon", "repo": "https://github.com/LZRBBNET/lzr-hub",
        "branch": "review/render-synthetic-initialization-package-20261105", "autoDeployTrigger": "off",
        "buildCommand": "npm ci --include=dev && node --experimental-strip-types scripts/synthetic-web.mjs build",
        "startCommand": "node --experimental-strip-types scripts/synthetic-web.mjs start",
    }
    require(set(service) == set(expected) | {"envVars"})
    require(all(service[key] == value for key, value in expected.items()))
    require(database == {
        "name": "lzr-synthetic-review-db-20261105", "plan": "free", "region": "oregon",
        "postgresMajorVersion": "17", "databaseName": "lzr_synthetic_demo", "user": "lzr_synthetic_demo",
        "ipAllowList": [],
    })
    require(isinstance(service["envVars"], list))
    env = {}
    for item in service["envVars"]:
        require(isinstance(item, dict) and isinstance(item.get("key"), str) and item["key"] not in env)
        env[item["key"]] = item
    require(set(env) == set(FLAGS) | {"SYNTHETIC_DEMO_ORIGIN", "DATABASE_URL"})
    for key, value in FLAGS.items():
        require(env[key] == {"key": key, "value": value})
    require(env["SYNTHETIC_DEMO_ORIGIN"] == {"key": "SYNTHETIC_DEMO_ORIGIN", "sync": False})
    require(env["DATABASE_URL"] == {"key": "DATABASE_URL", "fromDatabase": {
        "name": database["name"], "property": "connectionString"}})
    return {"validLocalPolicy": True, "officialApiValidated": False, "provisioningAuthorized": False,
            "resources": 2, "plans": ["free", "free"], "externalDatabaseAccess": False}


if __name__ == "__main__":
    try:
        target = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[1] / "deploy/render/render.synthetic-review.yaml"
        print(json.dumps(validate(yaml.load(target.read_text(), Loader=UniqueLoader))))
    except Exception:
        print("SYNTHETIC_BLUEPRINT_REFUSED: YAML or local review policy invalid", file=sys.stderr)
        sys.exit(1)
