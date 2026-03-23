#!/usr/bin/env bash
# simulate-agents.sh — Simulates 2 active subagents + 2 exec-processes for ClawLibrary demo
# Runs in background, cycles focus zones every 12s, cleans up on exit

OPENCLAW_HOME="$HOME/.openclaw"
SUBAGENTS_DIR="$OPENCLAW_HOME/subagents"
RUNS_FILE="$SUBAGENTS_DIR/runs.json"
PROCESSES_FILE="$OPENCLAW_HOME/exec-processes.json"

mkdir -p "$SUBAGENTS_DIR"

# Agent IDs
AGENT_A_ID="sim-agent-alpha-001"
AGENT_B_ID="sim-agent-beta-002"
PROC_A_ID="sim-proc-build-001"
PROC_B_ID="sim-proc-watch-002"

# Zone rotation for agent A (subagent — goes to all rooms)
ZONES_A=("memory" "mcp" "skills" "images" "gateway" "log" "schedule" "alarm")
# Zone rotation for agent B (subagent — different set)
ZONES_B=("document" "agent" "gateway" "memory" "skills" "mcp" "log")

cleanup() {
  echo "Cleaning up simulation..."
  rm -f "$SUBAGENTS_DIR/focus-${AGENT_A_ID}.json"
  rm -f "$SUBAGENTS_DIR/focus-${AGENT_B_ID}.json"

  # Restore runs.json removing sim entries
  if command -v python3 &>/dev/null; then
    python3 -c "
import json, os
path = '$RUNS_FILE'
try:
    with open(path) as f:
        data = json.load(f)
    runs = data.get('runs', {})
    runs.pop('$AGENT_A_ID', None)
    runs.pop('$AGENT_B_ID', None)
    data['runs'] = runs
    with open(path, 'w') as f:
        json.dump(data, f, indent=2)
except Exception as e:
    print(f'cleanup error: {e}')
"
  fi

  # Restore exec-processes.json removing sim entries
  if command -v python3 &>/dev/null; then
    python3 -c "
import json, os
path = '$PROCESSES_FILE'
try:
    with open(path) as f:
        procs = json.load(f)
    procs = [p for p in procs if p.get('id') not in ['$PROC_A_ID', '$PROC_B_ID']]
    with open(path, 'w') as f:
        json.dump(procs, f, indent=2)
except Exception as e:
    print(f'cleanup error: {e}')
"
  fi

  echo "Simulation stopped."
  exit 0
}

trap cleanup EXIT INT TERM

# Inject active subagents into runs.json
python3 -c "
import json, time, os
path = '$RUNS_FILE'
now_ms = int(time.time() * 1000)
try:
    with open(path) as f:
        data = json.load(f)
except:
    data = {'version': 2, 'runs': {}}

data['runs']['$AGENT_A_ID'] = {
    'runId': '$AGENT_A_ID',
    'childSessionKey': 'agent:main:subagent:$AGENT_A_ID',
    'controllerSessionKey': 'agent:main:main',
    'task': 'Scanning codebase and analyzing architecture patterns across all rooms',
    'label': 'alpha · scan',
    'model': 'anthropic/claude-sonnet-4-6',
    'workspaceDir': '${OPENCLAW_HOME}/workspace',
    'createdAt': now_ms,
    'startedAt': now_ms,
    'spawnMode': 'run',
    'cleanup': 'keep',
    'expectsCompletionMessage': False
}
data['runs']['$AGENT_B_ID'] = {
    'runId': '$AGENT_B_ID',
    'childSessionKey': 'agent:main:subagent:$AGENT_B_ID',
    'controllerSessionKey': 'agent:main:main',
    'task': 'Reviewing documents and memory files for consistency checks',
    'label': 'beta · review',
    'model': 'anthropic/claude-sonnet-4-6',
    'workspaceDir': '${OPENCLAW_HOME}/workspace',
    'createdAt': now_ms,
    'startedAt': now_ms,
    'spawnMode': 'run',
    'cleanup': 'keep',
    'expectsCompletionMessage': False
}

with open(path, 'w') as f:
    json.dump(data, f, indent=2)
print('Injected active subagents into runs.json')
"

# Inject exec-processes into exec-processes.json
python3 -c "
import json, time, os
path = '$PROCESSES_FILE'
now = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
try:
    with open(path) as f:
        procs = json.load(f)
except:
    procs = []

# Remove old sims if any
procs = [p for p in procs if p.get('id') not in ['$PROC_A_ID', '$PROC_B_ID']]

procs.append({
    'id': '$PROC_A_ID',
    'label': 'npm build --watch',
    'command': 'npm run build:watch',
    'status': 'running',
    'startedAt': now
})
procs.append({
    'id': '$PROC_B_ID',
    'label': 'vite dev server',
    'command': 'vite dev',
    'status': 'running',
    'startedAt': now
})

with open(path, 'w') as f:
    json.dump(procs, f, indent=2)
print('Injected exec-processes')
"

echo "Simulation running. Press Ctrl+C to stop."
echo "  Agent A (alpha·scan): ${ZONES_A[*]}"
echo "  Agent B (beta·review): ${ZONES_B[*]}"
echo "  Exec procs: npm build --watch, vite dev server"

IDX_A=0
IDX_B=0
DETAILS_A=(
  "scanning memory files for patterns"
  "analyzing MCP code repositories"
  "reading SKILL.md files"
  "reviewing image assets"
  "checking gateway config"
  "inspecting error logs"
  "reviewing scheduled tasks"
  "monitoring alarm signals"
)
DETAILS_B=(
  "reading task documents"
  "checking subagent outputs"
  "reviewing gateway integrations"
  "updating memory notes"
  "cross-referencing skill list"
  "validating MCP connections"
  "tailing recent log entries"
)

while true; do
  ZONE_A="${ZONES_A[$IDX_A]}"
  ZONE_B="${ZONES_B[$IDX_B]}"
  DETAIL_A="${DETAILS_A[$IDX_A]}"
  DETAIL_B="${DETAILS_B[$IDX_B]}"

  # Write focus files for subagents
  echo "{\"resourceId\":\"${ZONE_A}\",\"detail\":\"${DETAIL_A}\"}" > "$SUBAGENTS_DIR/focus-${AGENT_A_ID}.json"
  echo "{\"resourceId\":\"${ZONE_B}\",\"detail\":\"${DETAIL_B}\"}" > "$SUBAGENTS_DIR/focus-${AGENT_B_ID}.json"

  echo "[$(date +%H:%M:%S)] alpha → ${ZONE_A} | beta → ${ZONE_B}"

  IDX_A=$(( (IDX_A + 1) % ${#ZONES_A[@]} ))
  IDX_B=$(( (IDX_B + 1) % ${#ZONES_B[@]} ))

  sleep 12
done
