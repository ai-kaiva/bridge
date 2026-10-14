# Kaiva Bridge with NVIDIA NeMo Agent Toolkit

An agent built with [NeMo Agent Toolkit](https://docs.nvidia.com/nemo/agent-toolkit/latest/) that uses a
Kaiva Bridge MCP server as its tools and Nemotron as its model. Bridge turns an API, database or documents
into a hosted MCP server; the toolkit connects to it like any other MCP server.

## Run it

```bash
pip install "nvidia-nat[langchain,mcp]"  # Python 3.11 or later; the agent ships in the langchain plugin
export NVIDIA_API_KEY=nvapi-...           # from build.nvidia.com
nat run --config_file config.yml \
  --input "Which version of express is the latest, and what is its licence?"
```

The agent lists the server's tools, calls them, and answers from what they returned. It uses the toolkit's
tool-calling agent, which suits Nemotron's native tool calls. Checked on 14 October 2026 with NeMo Agent Toolkit
1.9.0 and Nemotron 3 Super: it called `get_package` and `get_package_version` and answered "5.3.0, MIT".

## Use your own API or database

1. Make a server. With no account, from a public OpenAPI spec:
   `npx -y @kaiva/bridge try --openapi https://api.example.com/openapi.json`.
   With an account, from a database: `npx -y @kaiva/bridge push shop-db --db --read-only`.
2. Put its address in `config.yml` under `function_groups.bridge.server.url`.
3. A server that needs a key or sign-in: see the toolkit's
   [MCP authentication](https://docs.nvidia.com/nemo/agent-toolkit/latest/components/auth/mcp-auth/index.html).

The demo server in `config.yml` is public and read-only. Kaiva is a member of NVIDIA Inception.
