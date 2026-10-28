(() => {
  let member;
  let current = 'own';
  const get = id => document.getElementById(id);
  const tabs = () => [...document.querySelectorAll('[data-workspace-tab]')];

  window.selectWorkspaceTab = (name, focus = false) => {
    const selected = get('tab-' + name);
    if (!selected || selected.hidden) return;
    current = name;
    tabs().forEach(tab => {
      const active = tab === selected;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      get('panel-' + tab.dataset.workspaceTab).hidden = !active;
    });
    // On a phone the tab row scrolls sideways; keep the chosen tab in view.
    selected.parentElement.scrollLeft = selected.offsetLeft - 16;
    if (focus) selected.focus();
  };
  tabs().forEach(tab => {
    tab.addEventListener('click', () => selectWorkspaceTab(tab.dataset.workspaceTab));
    tab.addEventListener('keydown', event => {
      const visible = tabs().filter(item => !item.hidden);
      const index = visible.indexOf(tab);
      const next = event.key === 'ArrowRight' ? (index + 1) % visible.length
        : event.key === 'ArrowLeft' ? (index - 1 + visible.length) % visible.length
        : event.key === 'Home' ? 0 : event.key === 'End' ? visible.length - 1 : -1;
      if (next < 0) return;
      event.preventDefault();
      selectWorkspaceTab(visible[next].dataset.workspaceTab, true);
    });
  });

  function jump(name, target) {
    selectWorkspaceTab(name);
    const element = get(target);
    if (element) {
      element.scrollIntoView({ block: 'center', behavior: 'instant' });
      const control = element.matches('input,button,a,textarea') ? element : element.querySelector('input,button,a,textarea');
      if (control) control.focus({ preventScroll: true });
    }
  }

  async function showPublication() {
    selectWorkspaceTab('own');
    const id = member.openObligationId;
    const findRow = () => [...get('generationsTable').querySelectorAll('[data-generation-id]')]
      .find(row => row.dataset.generationId === id);
    let row = findRow();
    if (!row) {
      await loadGenerations();
      // The obligation may have changed while the list was loading.
      if (member.openObligationId !== id) return;
      row = findRow();
    }
    if (row) {
      document.querySelectorAll('.workspace-pending-target').forEach(item => item.classList.remove('workspace-pending-target'));
      row.classList.add('workspace-pending-target');
      row.tabIndex = -1;
      row.focus({ preventScroll: true });
      row.scrollIntoView({ block: 'center', behavior: 'instant' });
      const link = row.querySelector('a[href]');
      if (link) link.focus({ preventScroll: true });
      else notice('ok', 'Your pending report is still being prepared. Its progress is shown in the selected row.');
      return;
    }
    notice('ok', 'Your pending report is not in this list yet. Open its workspace to check its status.');
    const link = document.createElement('a');
    link.href = workspaceUrl(id);
    link.textContent = 'Open pending report';
    link.className = 'btn btn-outline-dark btn-sm';
    get('notice').append(' ', link);
    link.focus();
  }

  // Only what blocks the member's next step is listed; everything else lives in its tab.
  window.refreshWorkspaceAttention = () => {
    if (!member) return;
    const review = Boolean(window._openReviewId);
    const publication = Boolean(member.openObligationId);
    get('reviewTabBadge').hidden = !review;
    get('tab-analysts').hidden = !(member.usage.analystReadLimit > 0 || member.publishes || review);
    // A pending review remains reachable even when the monthly allowance is zero.
    get('analysesCard').hidden = get('tab-analysts').hidden;
    const due = get('workspaceDue');
    due.replaceChildren();
    const add = (title, text, label, action) => {
      const item = document.createElement('li');
      const heading = document.createElement('h2');
      const body = document.createElement('p');
      const button = document.createElement('button');
      heading.textContent = title;
      body.textContent = text;
      button.type = 'button';
      button.className = 'btn btn-sm ' + (due.children.length ? 'btn-outline-dark' : 'btn-primary');
      button.textContent = label;
      button.addEventListener('click', action);
      item.append(heading, body, button);
      due.appendChild(item);
    };
    if (publication) add('Publish your report', 'Revise it until you stand behind it, then publish. Your next free generation unlocks when it is published.', 'View your report', showPublication);
    if (review) add('Review the analyst report you opened', 'Your next analyst read unlocks once the review is in.', 'Write the review', () => jump('analysts', 'reviewRow'));
    due.hidden = !publication && !review;
    if (get('tab-' + current).hidden) selectWorkspaceTab('own');
  };

  window.configureWorkspace = data => {
    const first = !member;
    member = data;
    get('tab-income').hidden = !data.publishes;
    const active = data.tier !== 'none' && ['active', 'past_due'].includes(data.tierStatus);
    const tier = get('tierBadge').textContent;
    get('workspacePlan').textContent = active
      ? tier + (data.tierStatus === 'past_due' ? ', payment past due.' : ', active.')
      : data.tier === 'none' ? 'No subscription.' : tier + ', inactive.';
    get('genPath').closest('details').hidden = get('genPath').hidden;
    if (data.publishes && !data.hasGeneration) loadEarnings();
    refreshWorkspaceAttention();
    if (first && !get('tab-analysts').hidden) loadAnalyses();
    if (first) selectWorkspaceTab(data.hasGeneration || data.publishes ? 'own' : 'library');
  };
})();
