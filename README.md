# projtrack

projtrack is a tracker for small projects such as certification study plans, with a personal budget tracker built in. Each project has a start and target date, a status, a color, and a list of milestones. The main view is a Gantt timeline or a kanban board of milestones, and a detail pane edits the selected project or milestone. It runs entirely in the browser as a static site, and the UI uses a Tokyo Night dark theme.

![projtrack timeline](docs/screenshots/timeline.png)

## Features

- Projects with a start and target date, a status, a color, and a list of milestones.
- Milestones with a due date, an optional start date, and an optional cost in JPY.
- Milestone costs are encrypted at rest, and the detail pane and top bar show per-project and total sums.
- Password lock: the app stays locked until you enter the password.
- Gantt timeline with expandable milestone sub-bars that show each milestone's span. In-progress milestones are yellow.
- On the timeline, each project bar fills up to its latest done milestone's marker. The detail pane shows progress as milestones done out of total (for example 2/5), with a bar to match.
- Milestone status (todo, doing or done) is set with the status pill in the detail pane. It replaces the old done checkbox.
- Milestone priority (none, low, medium or high) is set in the add form and shown as a small `!`, `!!` or `!!!` marker on board cards and in the detail pane. Click the marker in the detail pane to change it.
- Projects can carry free-form tags (lowercased, up to 10 per project, 30 characters each), entered comma-separated in the project form and shown as chips in the detail pane. A tag filter next to the tabs narrows both the timeline and the board.
- Milestone notes (optional, up to 250 characters) accept a safe markdown subset: bold, italic, inline code, http/https/mailto links, bullet and numbered lists. A `≡` marker on the row and on board cards shows that a milestone has notes; click it in the detail pane to show or hide them.
- Edit any field of a milestone (title, dates, cost, priority, status, project) in the detail pane: click the `✎` button on its row, double-click its title, double-click a board card, or press `e` with the milestone selected. Save sends only the changed fields; a cost that cannot be decrypted is left alone unless you type a new one. Choosing another project moves the milestone to the end of that project's list.
- Milestones in the detail list can be rearranged by dragging rows or with Shift+J / Shift+K on the selected milestone (click a row to select it). The order is kept per project, separate from the board's column order; the timeline still places bars by date.
- Kanban board with todo, in progress and done columns of milestones from all projects, a project filter, drag and drop, and fullscreen.
- Budget section (switch with `projects` / `budget` in the top bar, or Shift+B / Shift+P): see [Budget](#budget).

## Use it

Live at https://miloshkii.github.io/projtrack-web/

projtrack is a static, browser-only app. There is no server and no account. All data stays in this browser on this device (IndexedDB), so clearing site data deletes it and other browsers or devices do not see it. Use export to back it up.

### Run locally

```sh
python3 -m http.server -d web 8000
```

Then open http://127.0.0.1:8000. Any static file server works, and the app also works from a subpath such as `/projtrack-web/`.

## Budget

The budget section was merged in from the standalone Budget app, so one static site offers both. Its data lives in the same browser database and behind the same password; nothing is sent to a server.

- Income by date and category, with an optional source and note.
- Expenses, either a `transaction` (a day and a payee) or a `lump` purchase (belongs to the month).
- Subscriptions: weekly, monthly, quarterly or yearly, with a start date and an optional end date. They appear automatically in every month they cover (a charge on the 31st lands on the last day of shorter months).
- Month view with income, spend, recurring costs, net and savings rate, plus the month's income, expense and recurring tables (sort by column, filter by text, category, currency and type).
- Analytics over 3, 6, 12 or all months: averages, income vs spend chart, savings rate trend, category shares, this month against the average, and the share of spend that is recurring.
- Settings: base currency, income and expense category lists (reorder with the buttons or Alt+Up/Down on a row's handle), auto-lock time, exchange rates, password change and a CSV export of the selected month.

**Multi-currency.** Every entry has its own currency; totals are converted into the base currency (default JPY). Rates come from [Frankfurter](https://frankfurter.dev) (ECB reference rates) and are cached per month in the browser. A month uses its own rate, else the nearest earlier month, else the nearest later one. A past month is fetched again only if its stored rate predates the month's last ECB business day; the current month is updated on every refresh. Amounts with no usable rate show `rate?`, are left out of all totals and are counted in a banner. You can enter a manual rate per month and currency; it always wins over the ECB rate and is never overwritten (`↺ ecb` removes it). Everything works offline from cached rates.

**Privacy.** Rates are fetched by your browser from `api.frankfurter.dev`, only when you press `refresh` in settings or turn on "fetch exchange rates automatically" (off by default). Only currency codes and dates are sent, never amounts or text.

**Encryption.** Payee, income source, subscription name and notes are encrypted like milestone costs (AES-GCM with the key from your password). Amounts, dates, categories and currencies stay readable in the stored data.

The auto-lock time (default 15 minutes without activity) is set in the budget settings and locks the whole app. There is no separate budget passphrase: the password change form in the budget settings is the same as the `password` button in the top bar.

## Password and encrypted costs

On first launch the app asks you to set a password (at least 8 characters). The password is stored only as a PBKDF2-SHA256 verifier. Milestone costs (in JPY) and the budget's free-text fields are encrypted with AES-GCM using a key derived from your password (PBKDF2-SHA256, separate salt). That key is held only in memory while the app is unlocked, so reloading the page locks it.

![Unlock screen](docs/screenshots/login.png)

- Reloading the page or pressing `L` (Shift+L) locks the app.
- Use the `password` button in the top bar to change the password. Costs and budget text are re-encrypted with the new one.
- Forgetting the password is not recoverable. Use `forgot password` on the unlock screen (it asks for confirmation) to clear it and set a new one. Existing costs and budget text become unreadable; they show as `locked` and are not deleted.

## Backup

- `export` in the top bar downloads all data as a JSON file. The budget (entries, rates and settings) is included. Encrypted costs and text stay encrypted in the file, together with the salts and password verifier, so a backup restores with the same password.
- `import` replaces all current data with a backup file after a confirmation. The file is validated first, and the app locks afterwards so you unlock with the backup's password. Backups made before the budget existed still import (the budget is then empty).

## Demo data

On an empty detail pane, `load demo data` adds sample projects and milestones. Projects whose name already exists are skipped.

## Board

![Kanban board](docs/screenshots/board.png)

The board shows the milestones of all projects in three columns: todo, in progress and done. Press `b` to open it and `t` to return to the timeline.

- Drag a card to another column or to a new place in a column. With a card selected, `h` and `l` move it one column left or right, to the end of that column.
- Use `j` and `k` to select the next or previous card. The project filter above the board shows one project's milestones only.
- Press `f` (or the `[ ]` button) to make the board fullscreen.

## Keyboard shortcuts

Keys typed into a form field are ignored, except `Esc`. Shortcuts with Ctrl, Cmd or Alt are ignored too.

| Key | Action |
| --- | --- |
| `j` / `ArrowDown` | Select next project (board: next card) |
| `k` / `ArrowUp` | Select previous project (board: previous card) |
| `h` / `ArrowLeft` | Board: move the selected card to the left column |
| `l` / `ArrowRight` | Board: move the selected card to the right column |
| `t` | Timeline view |
| `b` | Board view |
| `f` | Toggle fullscreen |
| `n` | New project |
| `m` | New milestone for the selected project |
| `e` | Edit the selected milestone (board card, or a row clicked in the detail list); otherwise the selected project |
| `J` / `K` | Move the selected milestone down / up in its project's list (Shift+J / Shift+K) |
| `x` | Advance the first open milestone one status (todo, doing, done); reopens the last one when all are done |
| `o` | Expand / collapse the selected project's milestones |
| `d` | Delete selected project (asks for confirmation) |
| `Tab` | Switch focused pane |
| `Esc` | Close help, or exit fullscreen and cancel the open form |
| `L` | Lock (Shift+L) |
| `?` | Show or hide help |

![Help overlay](docs/screenshots/help.png)

### Budget shortcuts

Shown when the budget section is open (the shortcuts above do not apply there). Keys typed into a form field, and any key while a form is open, are ignored.

| Key | Action |
| --- | --- |
| `i` / `e` / `s` | New income / expense / subscription |
| `/` | Focus the search of the expenses or subscriptions filter bar |
| `h` / `l` | Previous / next month |
| `m` / `a` | Month / analytics tab |
| `1` `2` `3` `4` | Month, analytics, subscriptions, settings tabs |
| `Shift+P` / `Shift+B` | Projects / budget section |
| `Esc` | Close the open form |
| `L` | Lock (Shift+L) |
| `?` | Show or hide help |

## Development

```sh
node --test
```

Tests use Node's built-in runner (Node 26 or newer, no npm dependencies) against `web/localapi.js` with an in-memory store. The budget logic (schedule, analytics, rates, CSV) is DOM-free and tested directly; exchange-rate fetching is tested with an injected fetch function, so no test touches the network. PBKDF2 iterations are lowered in tests through the `iterations` option of `createApi`.

Pushing to `main` runs the tests and deploys `web/` to GitHub Pages (`.github/workflows/pages.yml`). Enable Pages with source "GitHub Actions" in the repository settings.

## Project layout

```
web/                 The whole site; deployed as is
  index.html         Page shell and help overlay
  app.js             UI state, detail pane and calls to the in-browser API
  localapi.js        In-browser backend: routes, validation, board ordering, auth, backup
  cryptoutil.js      PBKDF2 verifier and AES-GCM cost encryption (Web Crypto)
  storage.js         Storage interface: IndexedDB store and in-memory store
  demo.js            Sample data
  idle.js            Auto-lock after inactivity
  budget/            Budget section, merged from the Budget app
    api.js             Budget routes for localapi.js: entries, month view, analytics, rates, settings, CSV
    store.js           Budget records in the database, text encryption, password re-encryption, backup validation
    validate.js        Request validation
    schedule.js        Subscription occurrences per month
    analytics.js       Month totals and multi-month analytics
    rates.js           Rate lookup with month fallback, refresh rules, Frankfurter client
    currencies.js      Currency list, rounding and money formatting
    csv.js, months.js  CSV export and month arithmetic
    charts.js          SVG charts
    ui.js              Budget tabs, forms and tables
  gantt.js           SVG Gantt timeline renderer
  board.js           Kanban board columns, cards and drag and drop
  auth.js            Unlock, set-password and forgot-password view
  dom.js             DOM, date and yen formatting helpers
  keys.js            Keyboard shortcuts
  style.css          Tokyo Night theme and layout
tests/               node --test suite (projects, milestones, board, auth, backup, budget)
docs/screenshots/    README screenshots
.github/workflows/   GitHub Pages deploy
AGENTS.md            Operating rules for AI coding agents
CLAUDE.md            Claude Code project instructions (imports AGENTS.md)
.claude/agents/      Subagent definitions: coder, senior-coder, planner
```
