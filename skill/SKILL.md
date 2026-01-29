---
name: task-monitor
description: Start, diagnose, and repair the Claude Task Monitor services. Use when monitoring tasks, checking monitor health, or restarting the dashboard.
---

# Task Monitor Skill

Diagnose, repair, and report on the Claude Task Monitor — a real-time dashboard for Claude Code task lists.

## Quick Reference

| Component | What it does | Process |
|-----------|-------------|---------|
| Data generator + HTTP server | Watches `~/.claude/tasks/`, writes JSON + HTML, serves dashboard on port 8080 | `claude-task-monitor` |
| Config file | Stores projectDir, pollInterval, agentNames | `~/.claude/claude-task-monitor/monitor-config.json` |
| Dashboard URL | `http://localhost:8080/` | — |

## Workflow

When `/task-monitor` is invoked, execute ALL three phases in order.

### Phase 1: Diagnose

Run these diagnostic checks:

```bash
# 1. Check if the node process (data generator + HTTP server) is running
pgrep -f "claude-task-monitor" || pgrep -f "node.*dist/index.js" || echo "NODE_PROCESS_DOWN"

# 2. Check if HTTP server is responding and serving config API
curl -s http://localhost:8080/api/config || echo "HTTP_NOT_RESPONDING"

# 3. Check if data file exists and is fresh (modified in last 60 seconds)
DATA_FILE="$HOME/.claude/claude-task-monitor/task-monitor-data.json"
if [ -f "$DATA_FILE" ]; then
  AGE=$(( $(date +%s) - $(stat -c %Y "$DATA_FILE") ))
  if [ "$AGE" -gt 60 ]; then
    echo "DATA_FILE_STALE (${AGE}s old)"
  else
    echo "DATA_FILE_OK (${AGE}s old)"
  fi
else
  echo "DATA_FILE_MISSING"
fi

# 4. Check if config file exists and is valid JSON
CONFIG_FILE="$HOME/.claude/claude-task-monitor/monitor-config.json"
if [ -f "$CONFIG_FILE" ]; then
  python3 -c "import json; json.load(open('$CONFIG_FILE'))" 2>/dev/null && echo "CONFIG_OK" || echo "CONFIG_INVALID_JSON"
else
  echo "CONFIG_MISSING (will be created on restart)"
fi
```

Collect all results before proceeding.

### Phase 2: Repair (if needed)

Only repair if the node process is down or HTTP is not responding.

```bash
# Kill any stale instances
pkill -f "claude-task-monitor" 2>/dev/null
pkill -f "node.*claude-task-monitor.*dist/index.js" 2>/dev/null
# If port 8080 is occupied by something else, free it
fuser -k 8080/tcp 2>/dev/null
sleep 1
# Start fresh
nohup claude-task-monitor > /tmp/claude-task-monitor.log 2>&1 &
```

**After any repair, wait 2 seconds then re-run diagnostics to confirm fix.**

### Phase 3: Status Report

After diagnosis and any repairs, report to the user:

```
Task Monitor Status
-------------------
Node process:    [running/stopped]
Data file:       [fresh (Xs old) / stale (Xs old) / missing]
Dashboard:       http://localhost:8080/ [accessible/unreachable]
Config:          projectDir=<path>, pollInterval=<ms>
Settings:        http://localhost:8080/ → Settings button
Task lists:      [N active]
```

To get the number of active task lists:
```bash
curl -s http://localhost:8080/task-monitor-data.json | python3 -c "
import sys, json
data = json.load(sys.stdin)
lists = data.get('taskLists', [])
print(f'{len(lists)} task list(s)')
for tl in lists:
    tasks = tl.get('tasks', [])
    total = len(tasks)
    done = sum(1 for t in tasks if t.get('status') == 'completed')
    ip = sum(1 for t in tasks if t.get('status') == 'in_progress')
    print(f'  - {tl.get(\"id\", \"unnamed\")}: {done}/{total} done, {ip} in progress')
"
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Dashboard loads but shows no data | Node process crashed or data stale | Restart node process |
| Port 8080 refused | Node process crashed | Restart node process |
| Data file stale | Node process hung or tasks dir missing | Kill and restart node; check `~/.claude/tasks/` exists |
| Settings not saving | Config file permissions | Check write access to `~/.claude/claude-task-monitor/monitor-config.json` |
| Wrong project directory in launch commands | Config mismatch | Open Settings in dashboard or edit `monitor-config.json` |
| Both services die after terminal closes | Background process tied to shell | Start via `nohup` or `setsid` if persistence needed |

## Notes

- Single Node.js process handles both data generation and HTTP serving
- Built-in HTTP server on port 8080 (configurable via `CLAUDE_TASK_MONITOR_PORT` env var)
- Configuration stored in `~/.claude/claude-task-monitor/monitor-config.json`, editable via dashboard Settings or direct file edit
- The data generator uses `chokidar` to watch `~/.claude/tasks/` with 100ms polling
- The HTML dashboard polls `task-monitor-data.json` at the configured poll interval (default 2s)
- The data file and HTML are regenerated on every task file change
- Config file is watched for external edits and reloaded automatically
- Install or update the skill: `claude-task-monitor --install-skill`
