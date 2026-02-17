# Claude Task Monitor

Real-time task monitor dashboard for Claude Code task lists. Watches `~/.claude/tasks/` and serves an auto-updating browser dashboard.

## Installation

```bash
npm install -g claude-task-monitor
```

Or run directly with npx:

```bash
npx claude-task-monitor
```

## Usage

```bash
# Start the monitor (serves dashboard on http://localhost:8080/)
claude-task-monitor

# Install the Claude Code skill for /task-monitor command
claude-task-monitor --install-skill

# Show help
claude-task-monitor --help
```

Open http://localhost:8080/ in your browser to see the dashboard.

## Launch Command Integration

The monitor copies launch commands that target the standardized app scripts:

```bash
npm run agents:run -- --task-list <task-list-id> --agent <agent-name>
```

For specific-task launch buttons, it appends:

```bash
--mode task-<id>
```

This aligns monitor output with the `agent-platform` command surface.

## Features

- **Built-in HTTP server** - Dashboard served on port 8080, no separate server needed
- **Real-time updates** - Polls for changes every 2 seconds (configurable)
- **Auto-archive** - Archives completed task lists to `~/.claude/tasks/.archive/`
- **One-click launch** - Copy agent launch commands to clipboard
- **Agent naming** - Uses Greek alphabet for agent names (alpha, beta, gamma...)
- **Task dependencies** - Shows blocked tasks and their blockers
- **Settings panel** - Configure project directory, poll interval, and agent names from the dashboard
- **Claude Code skill** - Built-in `/task-monitor` skill for diagnosing and repairing the monitor

## Claude Code Skill

Install the bundled skill to get a `/task-monitor` command inside Claude Code:

```bash
claude-task-monitor --install-skill
```

This copies the skill file to `~/.claude/skills/task-monitor/SKILL.md`. The skill provides automated diagnosis, repair, and status reporting for the monitor.

## File Locations

| File | Path |
|------|------|
| Config | `~/.claude/claude-task-monitor/monitor-config.json` |
| Data (JSON) | `~/.claude/claude-task-monitor/task-monitor-data.json` |
| Dashboard (HTML) | `~/.claude/claude-task-monitor/task-monitor.html` |
| Task lists | `~/.claude/tasks/` |
| Archives | `~/.claude/tasks/.archive/` |
| Skill | `~/.claude/skills/task-monitor/SKILL.md` |

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `CLAUDE_TASK_MONITOR_DATA_DIR` | Data directory for config, JSON, and HTML output | `~/.claude/claude-task-monitor/` |
| `CLAUDE_TASK_MONITOR_OUTPUT` | Override output directory for HTML/JSON files | Same as data dir |
| `CLAUDE_TASK_MONITOR_PORT` | HTTP server port | `8080` |

## How It Works

1. Watches `~/.claude/tasks/` for task list directories using `chokidar`
2. Reads task JSON files and aggregates data
3. Generates a self-contained HTML dashboard and JSON data file
4. Serves the dashboard via built-in HTTP server
5. Archives task lists when Claude Code deletes them (all tasks completed)

## Upgrading from v1.x

v2.0.0 moves the config and output files from the project directory to `~/.claude/claude-task-monitor/`. On first run, the monitor will automatically migrate your existing `monitor-config.json` if found in the old location.

If you previously used a Python HTTP server to serve the dashboard, you can remove that — the built-in HTTP server handles everything.

After upgrading, run `claude-task-monitor --install-skill` to update the Claude Code skill with the new paths.

## License

MIT
