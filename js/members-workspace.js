(() => {
  const returnedTopup = new URLSearchParams(location.search).has('topup');
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

  window.refreshWorkspaceAttention = () => {
    if (!member) return;
    const review = Boolean(window._openReviewId);
    const publication = Boolean(member.openObligationId);
    get('reviewTabBadge').hidden = !review;
    get('tab-analysts').hidden = !(member.usage.analystReadLimit > 0 || member.publishes || review);
    // A pending review remains reachable even when the monthly allowance is zero.
    get('analysesCard').hidden = get('tab-analysts').hidden;
    const attention = get('workspaceAttention');
    attention.replaceChildren();
    const add = (label, action) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.addEventListener('click', action);
      attention.appendChild(button);
    };
    if (publication) add('Publication due  / View your report', showPublication);
    if (review) add('Review due  / Complete review', () => jump('analysts', 'reviewRow'));
    attention.hidden = !publication && !review;

    let title, text, label, action;
    if (publication) {
      title = 'Finish your report';
      text = 'Open your report, request your revisions and publish the version you stand behind.';
      label = 'View your report'; action = showPublication;
    } else if (review) {
      title = 'Complete your review';
      text = 'Review the report you opened before your next monthly read.';
      label = 'Write review'; action = () => jump('analysts', 'reviewRow');
    } else if (!get('reserveRow').hidden && !get('genCard').hidden) {
      title = member.publishes ? 'Start your next report' : 'Create your private report';
      text = get('genStatus').textContent;
      label = 'Choose a company'; action = () => jump('own', 'genCompany');
    } else if (member.usage.genReserved) {
      title = 'Continue your report';
      text = 'Follow its progress, then open the report and request revisions.';
      label = 'View your report'; action = () => jump('own', 'generationsTable');
    } else {
      title = 'Find your next report';
      text = 'Browse the ready-report library with your current access.';
      label = 'Browse ready reports'; action = () => jump('library', 'reportsTable');
    }
    get('workspaceNextTitle').textContent = title;
    get('workspaceNextText').textContent = text;
    const button = get('workspaceNextAction');
    button.textContent = label;
    button.onclick = action;
    get('workspaceNext').hidden = false;
    if (get('tab-' + current).hidden) selectWorkspaceTab('own');
  };

  window.configureWorkspace = data => {
    const first = !member;
    member = data;
    get('tab-income').hidden = !data.publishes;
    const active = data.tier !== 'none' && ['active', 'past_due'].includes(data.tierStatus);
    const tier = get('tierBadge').textContent;
    get('workspacePlan').textContent = active
      ? tier + (data.tierStatus === 'past_due' ? '  / Payment past due' : '  / Active')
      : data.tier === 'none' ? 'No paid subscription. Your current allowances are shown above.' : tier + '  / Subscription inactive';
    if (returnedTopup) document.querySelector('.workspace-allowances').open = true;
    document.querySelector('.workspace-help').hidden = get('genPath').hidden;
    if (data.publishes && !data.hasGeneration) loadEarnings();
    refreshWorkspaceAttention();
    if (first && !get('tab-analysts').hidden) loadAnalyses();
    if (first) selectWorkspaceTab(data.hasGeneration || data.publishes ? 'own' : 'library');
    get('myReviewsBtn').onclick = () => { selectWorkspaceTab('analysts'); myReviews(); };
  };
})();
