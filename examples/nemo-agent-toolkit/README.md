# Kaiva Bridge with NVIDIA NeMo Agent Toolkit

[![Launch on Brev](https://brev-assets.s3.us-west-1.amazonaws.com/nv-lb-dark.svg)](https://brev.nvidia.com/launchable/deploy?launchableID=env-3KgX27OJoHQOCv2ONqaJke4TqDI)

An agent built with [NeMo Agent Toolkit](https://docs.nvidia.com/nemo/agent-toolkit/latest/) that uses tools from
an MCP server hosted on Kaiva Bridge, with Nemotron as its model. Bridge turns an API, database or documents into a
hosted MCP server; the toolkit connects to that server like any other MCP server.

## Run it on NVIDIA Brev

1. Click **Launch on Brev** above and enter your NVIDIA API key (from build.nvidia.com) when asked.
2. When the instance is Running (about 7 minutes), open Jupyter, then a Terminal. The toolkit and your key are
   already set up.
3. Run:

```bash
cd ~/kaiva-bridge/examples/nemo-agent-toolkit
nat run --config_file config.yml --input "What is the licence of the npm package left-pad?"
```

Delete the instance when you are done; a stopped instance still pays for its disk.

## Run it on your own machine

```bash
pip install "nvidia-nat[langchain,mcp]"  # Python 3.11 or later; the agent ships in the langchain plugin
export NVIDIA_API_KEY=nvapi-...           # from build.nvidia.com
nat run --config_file config.yml \
  --input "What is the licence of the npm package left-pad?"
```

The agent lists the server's tools, calls them, and answers from what they returned. It uses the toolkit's
tool-calling agent, which suits Nemotron's native tool calls. Checked on 14 October 2026 with NeMo Agent Toolkit
1.9.0 and Nemotron 3 Super: on Brev it answered "left-pad 1.3.0, WTFPL"; locally, asked about express (a long
version history, so a slower run), it answered "5.3.0, MIT".

## Use your own API or database

1. Make a server. With no account, from a public OpenAPI spec:
   `npx -y @kaiva/bridge try --openapi https://api.example.com/openapi.json`.
   With an account, from a database: `npx -y @kaiva/bridge push shop-db --db --read-only`.
2. Put its address in `config.yml` under `function_groups.bridge.server.url`.
3. A server that needs a key or sign-in: see the toolkit's
   [MCP authentication](https://docs.nvidia.com/nemo/agent-toolkit/latest/components/auth/mcp-auth/index.html).

The demo server in `config.yml` is public and read-only. Kaiva is a member of NVIDIA Inception.
