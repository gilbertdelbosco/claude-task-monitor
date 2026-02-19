# Lessons Learned — claude-task-monitor

## Architecture

- **Single-file app**: All CSS, JS, and HTML generation live in `src/index.ts`. The TypeScript compiles to `dist/index.js`, which generates `task-monitor.html` with embedded `<style>` and `<script>` blocks.
- **Global install**: Production runs via `claude-task-monitor` (globally installed npm binary), not the local dev build. The running process at `localhost:8080` serves HTML generated from whatever version of `dist/index.js` was loaded at process start.

## Verification Before Release

1. **Always restart the server after code changes.** The running server caches the generated HTML from the code it was started with. Rebuilding (`npm run build`) and even updating the global install (`npm install -g .`) do NOT affect the running process. You must kill and restart it.
2. **Verify in the browser before committing.** Use `agent-browser` to screenshot `localhost:8080` and confirm changes are visually correct. Do not trust that code changes are working until you see them rendered.
3. **Check the served HTML, not just source.** Run `curl -s http://localhost:8080 | grep -c "<pattern>"` to confirm the live server is actually serving updated code.

## Release Checklist

1. Make code changes in `src/index.ts`
2. `npm run build` — compile TypeScript
3. Kill running `claude-task-monitor` process
4. `npm install -g .` — update global install
5. Restart: `claude-task-monitor &`
6. Verify via `agent-browser` screenshot at `localhost:8080`
7. **Get human approval** of the visual result
8. Bump version in `package.json`
9. Commit and push
10. `npm publish` — **must be run by the human in an interactive terminal.** The publish flow uses web-based auth ("Press ENTER to open in the browser...") which requires an interactive shell. Claude's Bash tool is non-interactive and cannot handle this. Do NOT attempt `npm publish` from Claude — tell the user to run it themselves.

## Past Mistakes

### v2.3.0 — CSS truncation + row readability (2026-02-19)

- **Mistake**: Committed, pushed, and attempted `npm publish` without verifying the changes were visible in the browser, and without waiting for human approval.
- **Root cause**: The server was still running old code. Changes appeared correct in source but were not reflected in the live UI.
- **Fix**: Restarted server with updated global install. Verified via `agent-browser` screenshot.
- **Rule**: Never commit or publish until changes are visually confirmed in the running dashboard and the human has approved.

### v2.3.0 — npm publish auth failure (2026-02-19)

- **Mistake**: Attempted `npm publish` from Claude's non-interactive Bash tool. When it failed with `EOTP`, incorrectly told the user they needed to provide a 2FA code.
- **Root cause**: npm's publish auth uses a web-based flow ("Press ENTER to open in the browser...") that requires an interactive terminal. Claude's Bash tool cannot handle interactive prompts or open browsers. npm fell back to requesting OTP, which was misleading.
- **What the user said**: "it will prompt you to hit enter to open a browser please do that and i will handle the auth for you" — this was correct. Should have listened.
- **Rule**: `npm publish` must always be run by the human in their own terminal. Claude should prepare everything (build, version bump, commit, push) and then tell the user to run `npm publish` themselves.
