// Keyboard shortcuts. Keys typed into form fields are left alone, except Esc.
const FIELD_TAGS = ['INPUT', 'TEXTAREA', 'SELECT'];

const isTyping = (el) => el.isContentEditable || FIELD_TAGS.includes(el.tagName);

export function bindKeys(actions) {
  const help = document.getElementById('help-overlay');
  const allPanes = [document.getElementById('timeline-pane'), document.getElementById('detail-pane')];
  const tiles = document.querySelector('.tiles');
  const visiblePanes = () => (tiles.classList.contains('fullscreen') ? allPanes.slice(0, 1) : allPanes);

  const toggleHelp = () => {
    for (const grid of help.querySelectorAll('[data-help]')) grid.hidden = grid.dataset.help !== actions.section();
    help.hidden = !help.hidden;
  };

  function focusNextPane() {
    const panes = visiblePanes();
    const current = panes.findIndex((p) => p.classList.contains('focused'));
    const next = panes[(current + 1) % panes.length];
    for (const p of panes) p.classList.toggle('focused', p === next);
  }

  function escape() {
    if (!help.hidden) help.hidden = true;
    else if (actions.section() === 'budget') actions.budgetEscape();
    else {
      actions.exitFullscreen();
      actions.cancelForm();
    }
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }

  const bindings = new Map([
    ['j', actions.selectNext],
    ['ArrowDown', actions.selectNext],
    ['k', actions.selectPrev],
    ['ArrowUp', actions.selectPrev],
    ['h', actions.moveCardLeft],
    ['ArrowLeft', actions.moveCardLeft],
    ['l', actions.moveCardRight],
    ['ArrowRight', actions.moveCardRight],
    ['t', actions.showTimeline],
    ['b', actions.showBoard],
    ['f', actions.toggleFullscreen],
    ['n', actions.startNewProject],
    ['m', actions.startNewMilestone],
    ['e', actions.startEdit],
    ['J', actions.moveMilestoneDown],
    ['K', actions.moveMilestoneUp],
    ['x', actions.toggleNextMilestone],
    ['o', actions.toggleExpand],
    ['d', actions.deleteSelected],
    ['B', () => actions.setSection('budget')],
    ['L', actions.lock],
    ['?', toggleHelp],
  ]);

  // The budget section has its own single keys; only these are shared with projects.
  const sharedBindings = new Map([
    ['P', () => actions.setSection('projects')],
    ['B', () => actions.setSection('budget')],
    ['L', actions.lock],
    ['?', toggleHelp],
  ]);

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (actions.isLocked()) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      escape();
      return;
    }
    if (isTyping(e.target)) return;
    if (actions.section() === 'budget') {
      if (actions.budgetFormOpen()) return;
      const shared = sharedBindings.get(e.key);
      if (shared || actions.budgetKey(e.key)) e.preventDefault();
      if (shared) shared();
      return;
    }
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      focusNextPane();
      return;
    }
    const action = bindings.get(e.key);
    if (!action) return;
    e.preventDefault();
    action();
  });
}
