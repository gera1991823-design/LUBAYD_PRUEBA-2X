'use strict';

const STORAGE_KEY = 'lubayd_partes_v3';
const LEGACY_KEYS = ['lubayd_partes_v2', 'lubayd_partes'];
const DRAFT_KEY = 'lubayd_parte_draft_v12';
const TOTAL_STEPS = 5;
const CHECK_IDS = ['agua', 'aceite', 'valvulina', 'giro', 'chequeoGral', 'cabezal', 'grua'];
const CHECK_LABELS = {
  agua: 'Agua',
  aceite: 'Aceite',
  valvulina: 'Valvulina',
  giro: 'Giro',
  chequeoGral: 'Chequeo general',
  cabezal: 'Cabezal',
  grua: 'Grúa'
};
const DRAFT_FIELDS = [
  'monte', 'fecha', 'maquina', 'operador', 'especie', 'largo',
  'horometroInicio', 'horometroFinal', 'arbolesIniciales', 'arbolesFinales', 'carros',
  'desde1', 'hasta1', 'trabajo1', 'mecanico1', 'observaciones', 'combustible',
  'hidraulico', 'controlado', 'firma', ...CHECK_IDS
];

let step = 1;
let currentGps = null;
let gpsInProgress = false;
let gpsAttemptedThisForm = false;
let deferredInstall = null;
let waitingWorker = null;
let cloudUnsubscribe = null;
let draftTimer = null;
let toastTimer = null;
let formInitialized = false;
let authenticatedUser = null;
let authenticatedProfile = null;
let authChangeSequence = 0;
let currentCloudStatus = {
  text: 'Conectando…',
  ok: false,
  detail: 'Esperando datos'
};

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

function loadRecords() {
  let raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    for (const key of LEGACY_KEYS) {
      raw = localStorage.getItem(key);
      if (raw) {
        localStorage.setItem(STORAGE_KEY, raw);
        break;
      }
    }
  }
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.warn('No se pudieron leer los registros locales:', error);
    return [];
  }
}

function sortRecords(records) {
  return [...records].sort((a, b) => String(b.createdAt || b.fecha || '').localeCompare(String(a.createdAt || a.fecha || '')));
}

const state = {
  get records() {
    return sortRecords(loadRecords());
  },
  save(records) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sortRecords(records)));
  },
  async saveRecord(record) {
    const records = this.records.filter(item => item.id !== record.id);
    records.unshift(record);
    this.save(records);
    renderAll();

    if (window.LubaydCloud?.available) {
      try {
        setCloudStatus('Sincronizando…', false, 'Guardando en la nube');
        await window.LubaydCloud.save(record);
        setCloudStatus('Sincronizado', true, `Actualizado ${formatTime(new Date())}`);
      } catch (error) {
        console.error('Guardar en Firestore:', error);
        this.save(this.records.filter(item => item.id !== record.id));
        renderAll();
        setCloudStatus('Error al guardar', false, 'El parte no fue confirmado por Firebase');
        throw error;
      }
    } else {
      setCloudStatus('Solo local', false, 'Firebase no está disponible');
    }
  },
  async deleteRecord(id) {
    this.save(this.records.filter(item => item.id !== id));
    renderAll();

    if (window.LubaydCloud?.available) {
      try {
        setCloudStatus('Sincronizando…', false, 'Eliminando registro');
        await window.LubaydCloud.remove(id);
        setCloudStatus('Sincronizado', true, `Actualizado ${formatTime(new Date())}`);
      } catch (error) {
        console.error('Eliminar en Firestore:', error);
        setCloudStatus('Pendiente', false, 'No se confirmó la eliminación en la nube');
      }
    }
  }
};

window.AppState = state;
window.escapeHtml = escapeHtml;

function currentUser() {
  return authenticatedUser;
}

function userDisplayName(user = currentUser()) {
  if (!user) return 'Usuario';
  return String(authenticatedProfile?.nombre || user.displayName || user.email?.split('@')[0] || 'Usuario').trim();
}

function userInitials(user = currentUser()) {
  const name = userDisplayName(user);
  const parts = name.split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : name.slice(0, 2)).toUpperCase();
}

function enforceAuthenticatedOperator() {
  const input = $('#operador');
  if (!input) return;
  input.value = currentUser() ? userDisplayName() : '';
  input.readOnly = true;
}

function updateUserInterface(user) {
  const name = userDisplayName(user);
  const email = user?.email || 'Sesión segura';
  const initials = userInitials(user);
  ['#sidebarUserName', '#topbarUserName'].forEach(selector => { if ($(selector)) $(selector).textContent = name; });
  ['#sidebarUserEmail', '#topbarUserEmail'].forEach(selector => { if ($(selector)) $(selector).textContent = email; });
  ['#sidebarAvatar', '#topbarAvatar'].forEach(selector => { if ($(selector)) $(selector).textContent = initials; });
  enforceAuthenticatedOperator();
  updateGreeting();
}

function setAuthMessage(text = '', type = '') {
  const message = $('#authMessage');
  if (!message) return;
  message.textContent = text;
  message.className = `auth-message ${type}`.trim();
}

function setAuthBusy(form, busy, label) {
  const button = form?.querySelector('button[type="submit"]');
  if (!button) return;
  if (!button.dataset.originalHtml) button.dataset.originalHtml = button.innerHTML;
  button.disabled = busy;
  button.innerHTML = busy ? `${escapeHtml(label)}…` : button.dataset.originalHtml;
}

function showAuthTab(tab) {
  $$('[data-auth-tab]').forEach(button => button.classList.toggle('active', button.dataset.authTab === tab));
  $('#loginForm')?.classList.toggle('active', tab === 'login');
  $('#registerForm')?.classList.toggle('active', tab === 'register');
  setAuthMessage('');
}

$$('[data-auth-tab]').forEach(button => button.addEventListener('click', () => showAuthTab(button.dataset.authTab)));

$('#loginForm')?.addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }
  setAuthBusy(form, true, 'Ingresando');
  setAuthMessage('');
  try {
    await window.LubaydAuth.login($('#loginEmail').value, $('#loginPassword').value);
  } catch (error) {
    setAuthMessage(window.LubaydAuth?.errorMessage?.(error) || 'No se pudo iniciar sesión.');
  } finally {
    setAuthBusy(form, false, 'Ingresando');
  }
});

$('#registerForm')?.addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.checkValidity()) {
    form.reportValidity();
    return;
  }
  if ($('#registerPassword').value !== $('#registerConfirm').value) {
    setAuthMessage('Las contraseñas no coinciden.');
    $('#registerConfirm').focus();
    return;
  }
  setAuthBusy(form, true, 'Creando usuario');
  setAuthMessage('');
  try {
    await window.LubaydAuth.register($('#registerName').value, $('#registerEmail').value, $('#registerPassword').value);
  } catch (error) {
    setAuthMessage(window.LubaydAuth?.errorMessage?.(error) || 'No se pudo crear el usuario.');
  } finally {
    setAuthBusy(form, false, 'Creando usuario');
  }
});

$('#resetPasswordBtn')?.addEventListener('click', async () => {
  const email = $('#loginEmail').value.trim();
  if (!email) {
    setAuthMessage('Escribe tu correo para enviarte el enlace de recuperación.');
    $('#loginEmail').focus();
    return;
  }
  try {
    await window.LubaydAuth.resetPassword(email);
    setAuthMessage('Te enviamos un correo para restablecer la contraseña.', 'success');
  } catch (error) {
    setAuthMessage(window.LubaydAuth?.errorMessage?.(error) || 'No se pudo enviar el correo.');
  }
});

async function logout() {
  if (!window.LubaydAuth?.available) return;
  if (!confirm('¿Cerrar la sesión actual?')) return;
  await window.LubaydAuth.logout();
}

$('#logoutBtn')?.addEventListener('click', logout);

async function handleAuthChange(user) {
  const sequence = ++authChangeSequence;
  cloudUnsubscribe?.();
  cloudUnsubscribe = null;
  authenticatedUser = null;
  authenticatedProfile = null;
  window.LubaydCurrentProfile = null;

  if (!user) {
    document.body.classList.remove('auth-ready');
    document.body.classList.add('auth-pending');
    setCloudStatus('Sesión cerrada', false, 'Inicia sesión para sincronizar');
    showAuthTab('login');
    window.setTimeout(() => $('#loginEmail')?.focus(), 120);
    return;
  }

  document.body.classList.remove('auth-ready');
  document.body.classList.add('auth-pending');
  setAuthMessage('Verificando autorización…', 'success');

  try {
    const profile = await window.LubaydAuth.getProfile(user);
    if (sequence !== authChangeSequence) return;

    if (!profile?.active) {
      await window.LubaydAuth.logout();
      window.setTimeout(() => {
        showAuthTab('login');
        $('#loginEmail').value = user.email || '';
        setAuthMessage('La cuenta fue creada, pero todavía debe ser habilitada por el administrador en Firebase.');
      }, 80);
      return;
    }

    authenticatedUser = user;
    authenticatedProfile = profile;
    window.LubaydCurrentProfile = profile;
    document.body.classList.remove('auth-pending');
    document.body.classList.add('auth-ready');
    setAuthMessage('');
    updateUserInterface(user);
    window.dispatchEvent(new CustomEvent('lubayd-profile-ready', { detail: { user, profile } }));
    initializeForm();
    renderAll();
    startCloudSync();
  } catch (error) {
    console.error('Verificación de usuario:', error);
    await window.LubaydAuth.logout().catch(() => {});
    window.setTimeout(() => setAuthMessage('No se pudo verificar la autorización del usuario. Revisa Firestore y vuelve a intentar.'), 80);
  }
}

window.addEventListener('lubayd-auth-changed', event => handleAuthChange(event.detail?.user || null));

const viewMeta = {
  dashboard: ['Centro de operaciones', 'Panel operativo'],
  nuevo: ['Registro guiado', 'Nuevo parte diario'],
  historial: ['Registros', 'Historial de partes'],
  graficos: ['Análisis operativo', 'Gráficos de producción'],
  ubicaciones: ['Geolocalización', 'Ubicaciones GPS'],
  chat: ['Comunicación interna', 'Mensajes del equipo']
};

function showView(id) {
  if (!currentUser()) return;
  if (!document.getElementById(id)) return;

  $$('.view').forEach(view => view.classList.toggle('active', view.id === id));
  $$('[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === id));

  const [eyebrow, title] = viewMeta[id] || ['Gestión forestal', 'Lubayd SA'];
  $('#pageEyebrow').textContent = eyebrow;
  $('#pageTitle').textContent = title;

  if (id === 'nuevo') {
    initializeForm();
    updateStep();
  }
  if (id === 'historial') renderHistory();
  if (id === 'ubicaciones') renderLocations();
  if (id === 'graficos' && typeof window.renderCharts === 'function') window.renderCharts();
  if (id === 'chat' && window.LubaydChatUI?.show) window.LubaydChatUI.show();

  closeSidebar();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

$$('[data-view], [data-view-link]').forEach(element => {
  element.addEventListener('click', () => showView(element.dataset.view || element.dataset.viewLink));
});
$('#heroNewBtn')?.addEventListener('click', () => showView('nuevo'));

function initializeForm() {
  if (formInitialized) {
    if (!$('#fecha').value) $('#fecha').value = todayKey();
    enforceAuthenticatedOperator();
    return;
  }

  formInitialized = true;
  if (!restoreDraft()) {
    $('#fecha').value = todayKey();
  }
  enforceAuthenticatedOperator();
  recalculateProduction();
  updateCheckCards();
  renderGpsState();
  refreshSuggestions();
  updateStep();
}

function updateStep() {
  $$('.form-page').forEach(page => page.classList.toggle('active', Number(page.dataset.step) === step));
  $$('.wizard-step').forEach((item, index) => {
    const itemStep = index + 1;
    item.classList.toggle('active', itemStep === step);
    item.classList.toggle('completed', itemStep < step);
    const button = item.querySelector('button');
    button.disabled = itemStep > step;
    button.setAttribute('aria-current', itemStep === step ? 'step' : 'false');
  });

  const labels = ['Datos generales', 'Producción', 'Chequeo', 'Ubicación', 'Resumen'];
  $('#mobileStepLabel').textContent = `Paso ${step} de ${TOTAL_STEPS}`;
  $('#stepText').textContent = labels[step - 1];
  $('#stepProgressBar').style.width = `${(step / TOTAL_STEPS) * 100}%`;
  $('#prevBtn').classList.toggle('hidden', step === 1);
  $('#nextBtn').classList.toggle('hidden', step === TOTAL_STEPS);
  $('#saveBtn').classList.toggle('hidden', step !== TOTAL_STEPS);
  clearFormMessage();

  if (step === 4 && !currentGps && !gpsInProgress && !gpsAttemptedThisForm) {
    gpsAttemptedThisForm = true;
    window.setTimeout(() => captureGps(true), 350);
  }
  if (step === 5) fillReview();
}

$$('.wizard-step').forEach(item => {
  item.querySelector('button')?.addEventListener('click', () => {
    const target = Number(item.dataset.stepTarget);
    if (target < step) {
      step = target;
      updateStep();
      scrollFormTop();
    }
  });
});

function scrollFormTop() {
  const shell = $('.wizard-shell');
  if (!shell) return;
  const offset = window.innerWidth <= 900 ? 82 : 96;
  window.scrollTo({ top: Math.max(0, shell.getBoundingClientRect().top + window.scrollY - offset), behavior: 'smooth' });
}

function validateStep(stepNumber, options = {}) {
  const page = $(`.form-page[data-step="${stepNumber}"]`);
  if (!page) return true;

  page.querySelectorAll('.field-error').forEach(field => field.classList.remove('field-error'));
  const required = [...page.querySelectorAll('input[required], select[required], textarea[required]')];

  for (const input of required) {
    if (!input.checkValidity()) {
      const field = input.closest('.field, .field-group') || input.parentElement;
      field?.classList.add('field-error');
      if (!options.silent) {
        showFormMessage('Completa los campos obligatorios marcados antes de continuar.', 'error');
        input.scrollIntoView({ behavior: 'smooth', block: 'center' });
        window.setTimeout(() => input.focus({ preventScroll: true }), 260);
      }
      return false;
    }
  }

  if (stepNumber === 2) {
    if (numberValue('#horometroFinal') < numberValue('#horometroInicio')) {
      showFormMessage('El horómetro final no puede ser menor que el inicial.', 'error');
      $('#horometroFinal').closest('.field')?.classList.add('field-error');
      if (!options.silent) $('#horometroFinal').scrollIntoView({ behavior: 'smooth', block: 'center' });
      return false;
    }
    if (numberValue('#arbolesFinales') < numberValue('#arbolesIniciales')) {
      showFormMessage('Los árboles finales no pueden ser menores que los iniciales.', 'error');
      $('#arbolesFinales').closest('.field')?.classList.add('field-error');
      if (!options.silent) $('#arbolesFinales').scrollIntoView({ behavior: 'smooth', block: 'center' });
      return false;
    }
  }

  if (stepNumber === 4) {
    if (!currentGps) {
      if (!options.silent) {
        showFormMessage('Debes obtener la ubicación actual antes de continuar.', 'error');
        captureGps(false);
      }
      return false;
    }
    const captured = new Date(currentGps.capturedAt || currentGps.positionTimestamp || 0).getTime();
    if (!captured || Date.now() - captured > 15 * 60 * 1000) {
      currentGps = null;
      renderGpsState('La ubicación venció. Obtén una nueva captura.');
      if (!options.silent) showFormMessage('La ubicación debe ser reciente. Vuelve a obtenerla.', 'error');
      return false;
    }
  }

  return true;
}

function validateAllSteps() {
  for (let target = 1; target <= 4; target += 1) {
    if (!validateStep(target, { silent: true })) {
      step = target;
      updateStep();
      validateStep(target);
      scrollFormTop();
      return false;
    }
  }
  return true;
}

$('#nextBtn')?.addEventListener('click', () => {
  if (!validateStep(step)) return;
  step = Math.min(TOTAL_STEPS, step + 1);
  updateStep();
  scrollFormTop();
});

$('#prevBtn')?.addEventListener('click', () => {
  step = Math.max(1, step - 1);
  updateStep();
  scrollFormTop();
});

$('#cancelBtn')?.addEventListener('click', () => {
  saveDraft();
  showToast('Borrador guardado', 'Puedes continuar el parte más tarde.');
  showView('dashboard');
});

function numberValue(selector) {
  return Number($(selector)?.value) || 0;
}

function radioValue(name) {
  return document.querySelector(`input[name="${name}"]:checked`)?.value || '';
}

function setRadioValue(name, value) {
  $$(`input[name="${name}"]`).forEach(input => {
    input.checked = input.value === value;
  });
}

function recalculateProduction() {
  const hours = Math.max(0, numberValue('#horometroFinal') - numberValue('#horometroInicio'));
  const trees = Math.max(0, numberValue('#arbolesFinales') - numberValue('#arbolesIniciales'));
  const performance = hours > 0 ? trees / hours : 0;

  $('#calcHoras').textContent = `${formatNumber(hours, 1)} h`;
  $('#calcArboles').textContent = formatNumber(trees);
  $('#calcRendimiento').textContent = `${formatNumber(performance, 1)} árb/h`;
}

['#horometroInicio', '#horometroFinal', '#arbolesIniciales', '#arbolesFinales'].forEach(selector => {
  $(selector)?.addEventListener('input', recalculateProduction);
});

function updateCheckCards() {
  CHECK_IDS.forEach(id => {
    const input = document.getElementById(id);
    const card = input?.closest('.check-card');
    const stateLabel = card?.querySelector('.check-state');
    if (stateLabel) stateLabel.textContent = input.checked ? 'Óptimo' : 'Pendiente';
  });
  const checkAllButton = $('#checkAllBtn');
  if (checkAllButton) {
    const allChecked = CHECK_IDS.every(id => document.getElementById(id)?.checked);
    checkAllButton.innerHTML = allChecked
      ? '<svg><use href="#i-check"></use></svg> Desmarcar todos'
      : '<svg><use href="#i-check"></use></svg> Marcar todos';
  }
}

CHECK_IDS.forEach(id => document.getElementById(id)?.addEventListener('change', updateCheckCards));

$('#checkAllBtn')?.addEventListener('click', () => {
  const shouldCheck = CHECK_IDS.some(id => !document.getElementById(id).checked);
  CHECK_IDS.forEach(id => { document.getElementById(id).checked = shouldCheck; });
  updateCheckCards();
  scheduleDraftSave();
  $('#checkAllBtn').innerHTML = shouldCheck
    ? '<svg><use href="#i-check"></use></svg> Desmarcar todos'
    : '<svg><use href="#i-check"></use></svg> Marcar todos';
});

function recordFromForm() {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    version: 12,
    createdAt: now,
    updatedAt: now,
    monte: $('#monte').value.trim(),
    fecha: $('#fecha').value,
    maquina: $('#maquina').value.trim(),
    operador: userDisplayName(),
    createdByUid: currentUser()?.uid || '',
    createdByEmail: currentUser()?.email || '',
    createdByName: userDisplayName(),
    turno: radioValue('turno'),
    especie: $('#especie').value,
    largo: numberValue('#largo'),
    horometroInicio: numberValue('#horometroInicio'),
    horometroFinal: numberValue('#horometroFinal'),
    horas: Math.max(0, numberValue('#horometroFinal') - numberValue('#horometroInicio')),
    arbolesIniciales: numberValue('#arbolesIniciales'),
    arbolesFinales: numberValue('#arbolesFinales'),
    arboles: Math.max(0, numberValue('#arbolesFinales') - numberValue('#arbolesIniciales')),
    carros: numberValue('#carros'),
    actividad: radioValue('actividad'),
    desde: $('#desde1').value,
    hasta: $('#hasta1').value,
    trabajo: $('#trabajo1').value.trim(),
    mecanico: $('#mecanico1').value.trim(),
    checks: Object.fromEntries(CHECK_IDS.map(id => [id, document.getElementById(id).checked])),
    observaciones: $('#observaciones').value.trim(),
    combustible: numberValue('#combustible'),
    hidraulico: numberValue('#hidraulico'),
    controlado: $('#controlado').value.trim(),
    firma: $('#firma').value.trim(),
    gps: currentGps ? { ...currentGps } : null
  };
}

function fillReview() {
  const record = recordFromForm();
  const completedChecks = CHECK_IDS.filter(id => record.checks[id]);
  const gpsText = record.gps
    ? `${record.gps.latitude.toFixed(5)}, ${record.gps.longitude.toFixed(5)} · ±${Math.round(record.gps.accuracy)} m`
    : 'Sin ubicación GPS';

  $('#reviewContent').innerHTML = `
    <div class="review-hero">
      <div>
        <span>PARTE LISTO PARA GUARDAR</span>
        <h4>${escapeHtml(record.monte) || 'Monte sin definir'}</h4>
        <p>${escapeHtml(record.operador)} · ${escapeHtml(record.maquina)} · ${formatDate(record.fecha)}</p>
      </div>
      <div class="review-production">
        <div><strong>${formatNumber(record.arboles)}</strong><small>Árboles</small></div>
        <div><strong>${formatNumber(record.horas, 1)} h</strong><small>Horas</small></div>
      </div>
    </div>
    <div class="review-grid">
      ${reviewItem('Fecha', formatDate(record.fecha))}
      ${reviewItem('Turno', record.turno || '—')}
      ${reviewItem('Especie', record.especie || '—')}
      ${reviewItem('Actividad', record.actividad || '—')}
      ${reviewItem('Carros', formatNumber(record.carros))}
      ${reviewItem('Rendimiento', `${formatNumber(record.horas ? record.arboles / record.horas : 0, 1)} árb/h`)}
      ${reviewItem('Combustible', `${formatNumber(record.combustible, 1)} L`)}
      ${reviewItem('Hidráulico', `${formatNumber(record.hidraulico, 1)} L`)}
      ${reviewItem('Ubicación', gpsText)}
    </div>
    <div class="review-checks">
      <span>Chequeos confirmados: ${completedChecks.length} de ${CHECK_IDS.length}</span>
      <div class="review-check-list">
        ${CHECK_IDS.map(id => `<b class="${record.checks[id] ? 'ok' : ''}">${record.checks[id] ? '✓' : '○'} ${CHECK_LABELS[id]}</b>`).join('')}
      </div>
    </div>
    ${record.observaciones ? `<div class="review-checks"><span>Observaciones</span><p style="margin:0;color:#425466;font-size:11px;white-space:pre-wrap">${escapeHtml(record.observaciones)}</p></div>` : ''}
  `;
}

function reviewItem(label, value) {
  return `<article><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></article>`;
}

$('#parteForm')?.addEventListener('submit', async event => {
  event.preventDefault();
  if (!currentUser()) {
    showFormMessage('Tu sesión terminó. Vuelve a ingresar.', 'error');
    return;
  }
  if (!validateAllSteps()) return;

  const saveButton = $('#saveBtn');
  const original = saveButton.innerHTML;
  saveButton.disabled = true;
  saveButton.innerHTML = '<svg><use href="#i-cloud"></use></svg> Guardando…';

  try {
    const record = recordFromForm();
    await state.saveRecord(record);
    resetForm({ clearDraft: true });
    showToast('Parte guardado', 'El registro quedó disponible en los dispositivos sincronizados.');
    showView('dashboard');
  } catch (error) {
    console.error('Guardar parte:', error);
    showFormMessage('No se pudo guardar el parte. Revisa la conexión e inténtalo nuevamente.', 'error');
  } finally {
    saveButton.disabled = false;
    saveButton.innerHTML = original;
  }
});

function resetForm({ clearDraft = false } = {}) {
  $('#parteForm').reset();
  currentGps = null;
  gpsInProgress = false;
  gpsAttemptedThisForm = false;
  step = 1;
  $('#fecha').value = todayKey();
  enforceAuthenticatedOperator();
  if (clearDraft) localStorage.removeItem(DRAFT_KEY);
  recalculateProduction();
  updateCheckCards();
  renderGpsState();
  updateStep();
  setDraftStatus('Guardado automático', 'Comienza a completar el nuevo parte');
}

function serializeDraft() {
  const values = {};
  DRAFT_FIELDS.forEach(id => {
    const element = document.getElementById(id);
    if (!element) return;
    values[id] = element.type === 'checkbox' ? element.checked : element.value;
  });

  return {
    values,
    turno: radioValue('turno'),
    actividad: radioValue('actividad'),
    savedAt: new Date().toISOString()
  };
}

function saveDraft() {
  if (!formInitialized) return;
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(serializeDraft()));
    setDraftStatus('Borrador guardado', `Actualizado ${formatTime(new Date())}`);
  } catch (error) {
    console.warn('No se pudo guardar el borrador:', error);
    setDraftStatus('Borrador no guardado', 'El almacenamiento del navegador no está disponible');
  }
}

function scheduleDraftSave() {
  window.clearTimeout(draftTimer);
  setDraftStatus('Guardando…', 'Conservando los cambios en este dispositivo');
  draftTimer = window.setTimeout(saveDraft, 380);
}

function restoreDraft() {
  const raw = localStorage.getItem(DRAFT_KEY);
  if (!raw) return false;

  try {
    const draft = JSON.parse(raw);
    Object.entries(draft.values || {}).forEach(([id, value]) => {
      const element = document.getElementById(id);
      if (!element) return;
      if (element.type === 'checkbox') element.checked = Boolean(value);
      else element.value = value ?? '';
    });
    setRadioValue('turno', draft.turno || '');
    setRadioValue('actividad', draft.actividad || '');
    currentGps = null;
    enforceAuthenticatedOperator();
    updateCheckCards();
    renderGpsState();
    setDraftStatus('Borrador recuperado', draft.savedAt ? `Guardado ${formatDateTime(draft.savedAt)}` : 'Puedes continuar donde lo dejaste');
    return true;
  } catch (error) {
    console.warn('No se pudo restaurar el borrador:', error);
    localStorage.removeItem(DRAFT_KEY);
    return false;
  }
}

$('#parteForm')?.addEventListener('input', scheduleDraftSave);
$('#parteForm')?.addEventListener('change', scheduleDraftSave);

$('#clearDraftBtn')?.addEventListener('click', () => {
  if (!confirm('¿Limpiar todos los campos del parte actual?')) return;
  resetForm({ clearDraft: true });
  showToast('Formulario limpio', 'El borrador anterior fue eliminado.');
});

$('#useLastRecordBtn')?.addEventListener('click', () => {
  const last = state.records[0];
  if (!last) {
    showToast('Sin registros anteriores', 'Guarda un parte para poder reutilizar sus datos frecuentes.');
    return;
  }

  $('#monte').value = last.monte || '';
  $('#maquina').value = last.maquina || '';
  enforceAuthenticatedOperator();
  $('#especie').value = last.especie || '';
  $('#largo').value = last.largo || '';
  setRadioValue('turno', last.turno || '');
  setRadioValue('actividad', last.actividad || '');
  scheduleDraftSave();
  showToast('Datos reutilizados', 'Se cargaron el monte, la máquina y otros datos frecuentes. El operador corresponde al usuario conectado.');
});

function setDraftStatus(title, text) {
  $('#draftStatusTitle').textContent = title;
  $('#draftStatusText').textContent = text;
}

function showFormMessage(text, type = '') {
  const message = $('#message');
  message.textContent = text;
  message.className = `form-message ${type}`.trim();
}

function clearFormMessage() {
  const message = $('#message');
  message.textContent = '';
  message.className = 'form-message';
}

function refreshSuggestions() {
  const records = state.records;
  fillDatalist('#monteOptions', records.map(record => record.monte));
  fillDatalist('#maquinaOptions', records.map(record => record.maquina));
  fillDatalist('#operadorOptions', records.map(record => record.operador));
}

function fillDatalist(selector, values) {
  const unique = [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'es'));
  $(selector).innerHTML = unique.map(value => `<option value="${escapeHtml(value)}"></option>`).join('');
}

function renderAll() {
  const records = state.records;
  const totalTrees = records.reduce((sum, record) => sum + (Number(record.arboles) || 0), 0);
  const totalHours = records.reduce((sum, record) => sum + (Number(record.horas) || 0), 0);
  const complete = records.filter(record => CHECK_IDS.every(id => Boolean(record.checks?.[id]))).length;
  const today = todayKey();
  const todayRecords = records.filter(record => record.fecha === today);
  const todayTrees = todayRecords.reduce((sum, record) => sum + (Number(record.arboles) || 0), 0);
  const todayHours = todayRecords.reduce((sum, record) => sum + (Number(record.horas) || 0), 0);
  const lastSevenCutoff = new Date();
  lastSevenCutoff.setHours(0, 0, 0, 0);
  lastSevenCutoff.setDate(lastSevenCutoff.getDate() - 6);
  const lastSeven = records.filter(record => {
    const date = parseRecordDate(record.fecha);
    return date && date >= lastSevenCutoff;
  });
  const sevenTrees = lastSeven.reduce((sum, record) => sum + (Number(record.arboles) || 0), 0);
  const sevenHours = lastSeven.reduce((sum, record) => sum + (Number(record.horas) || 0), 0);

  $('#kpiTotal').textContent = formatNumber(records.length);
  $('#kpiArboles').textContent = formatNumber(totalTrees);
  $('#kpiHoras').textContent = formatNumber(totalHours, 1);
  $('#kpiChequeos').textContent = `${records.length ? Math.round((complete / records.length) * 100) : 0}%`;
  $('#kpiTotalDelta').textContent = `${formatNumber(todayRecords.length)} hoy`;
  $('#kpiTreesDelta').textContent = `${formatNumber(todayTrees)} hoy`;
  $('#kpiHoursDelta').textContent = `${formatNumber(todayHours, 1)} h hoy`;
  $('#kpiChecksDelta').textContent = records.length ? `${complete} de ${records.length} completos` : 'Sin registros';
  $('#dashboardTrees7').textContent = formatNumber(sevenTrees);
  $('#dashboardHours7').textContent = `${formatNumber(sevenHours, 1)} h`;
  $('#dashboardAverage7').textContent = formatNumber(lastSeven.length ? sevenTrees / lastSeven.length : 0, 1);
  $('#lastUpdate').textContent = formatDateTime(new Date().toISOString());

  updateGreeting();
  renderRecent(records);
  refreshSuggestions();
  refreshOperatorFilters();

  if (typeof window.refreshChartOperators === 'function') window.refreshChartOperators();
  if (typeof window.renderDashboardTrend === 'function') window.renderDashboardTrend();
  if (typeof window.renderCharts === 'function' && $('#graficos')?.classList.contains('active')) window.renderCharts();
  if ($('#historial')?.classList.contains('active')) renderHistory();
  if ($('#ubicaciones')?.classList.contains('active')) renderLocations();

  window.dispatchEvent(new CustomEvent('lubayd-records-updated'));
}

function updateGreeting() {
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Buenos días' : hour < 20 ? 'Buenas tardes' : 'Buenas noches';
  $('#greetingTitle').textContent = `${greeting}, ${userDisplayName()}`;
  $('#currentDateText').textContent = new Date().toLocaleDateString('es-UY', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });
}

function renderRecent(records) {
  const root = $('#recentList');
  if (!records.length) {
    root.className = 'recent-list empty-state';
    root.textContent = 'Todavía no hay partes guardados.';
    return;
  }

  root.className = 'recent-list';
  root.innerHTML = records.slice(0, 5).map(record => `
    <article class="recent-item" data-detail="${escapeHtml(record.id)}" tabindex="0">
      <span class="recent-icon"><svg><use href="#i-tree"></use></svg></span>
      <div class="recent-copy"><strong>${escapeHtml(record.monte)} · ${escapeHtml(record.maquina)}</strong><span>${formatDate(record.fecha)} · ${escapeHtml(record.operador)} · ${escapeHtml(record.actividad || 'Sin actividad')}</span></div>
      <div class="recent-value"><strong>${formatNumber(record.arboles)}</strong><small>árboles</small></div>
      <svg><use href="#i-arrow"></use></svg>
    </article>
  `).join('');

  root.querySelectorAll('[data-detail]').forEach(item => {
    item.addEventListener('click', () => openDetail(item.dataset.detail));
    item.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') openDetail(item.dataset.detail);
    });
  });
}

function refreshOperatorFilters() {
  const operators = [...new Set(state.records.map(record => String(record.operador || '').trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'es'));
  const select = $('#historyOperatorFilter');
  const current = select.value;
  select.innerHTML = '<option value="">Todos los operadores</option>' + operators.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
  if (operators.includes(current)) select.value = current;
}

function filteredRecords() {
  const query = $('#historySearch').value.trim().toLowerCase();
  const date = $('#historyDateFilter').value;
  const activity = $('#activityFilter').value;
  const operator = $('#historyOperatorFilter').value;
  return state.records.filter(record => {
    const matchesQuery = !query || [record.monte, record.maquina, record.operador]
      .some(value => String(value || '').toLowerCase().includes(query));
    return matchesQuery
      && (!date || record.fecha === date)
      && (!activity || record.actividad === activity)
      && (!operator || record.operador === operator);
  });
}

function renderHistory() {
  const records = filteredRecords();
  const body = $('#historyBody');
  const cards = $('#historyCards');
  const empty = $('#historyEmpty');

  empty.classList.toggle('show', records.length === 0);
  $('#historyResultCount').textContent = `${formatNumber(records.length)} ${records.length === 1 ? 'registro' : 'registros'}`;
  const selectedDate = $('#historyDateFilter').value;
  $('#historyDateLabel').textContent = selectedDate ? `Día: ${formatDate(selectedDate)}` : 'Todos los días';
  body.innerHTML = records.map(record => `
    <tr>
      <td>${formatDate(record.fecha)}</td>
      <td><strong>${escapeHtml(record.monte)}</strong></td>
      <td>${escapeHtml(record.maquina)}</td>
      <td>${escapeHtml(record.operador)}</td>
      <td>${escapeHtml(record.actividad || '—')}</td>
      <td><strong>${formatNumber(record.arboles)}</strong></td>
      <td>
        <div class="table-actions">
          <button class="table-action" data-detail="${escapeHtml(record.id)}" aria-label="Ver detalle"><svg><use href="#i-eye"></use></svg></button>
          ${record.gps ? `<a class="table-action" href="${mapUrl(record.gps)}" target="_blank" rel="noopener" aria-label="Abrir mapa"><svg><use href="#i-pin"></use></svg></a>` : ''}
          ${canDeleteRecord(record) ? `<button class="table-action danger" data-delete="${escapeHtml(record.id)}" aria-label="Eliminar"><svg><use href="#i-trash"></use></svg></button>` : ''}
        </div>
      </td>
    </tr>
  `).join('');

  cards.innerHTML = records.map(record => `
    <article class="history-card">
      <div class="history-card-head">
        <div><strong>${escapeHtml(record.monte)} · ${escapeHtml(record.maquina)}</strong><span>${formatDate(record.fecha)} · ${escapeHtml(record.operador)}</span></div>
        <div class="history-card-value"><b>${formatNumber(record.arboles)}</b><small>árboles</small></div>
      </div>
      <div class="history-card-meta"><span>${escapeHtml(record.actividad || 'Sin actividad')}</span><span>${formatNumber(record.horas, 1)} h</span><span>${formatNumber(record.combustible, 1)} L</span></div>
      <div class="history-card-actions">
        <button data-detail="${escapeHtml(record.id)}"><svg><use href="#i-eye"></use></svg>Ver</button>
        ${record.gps ? `<a href="${mapUrl(record.gps)}" target="_blank" rel="noopener"><svg><use href="#i-pin"></use></svg>Mapa</a>` : '<span></span>'}
        ${canDeleteRecord(record) ? `<button class="danger" data-delete="${escapeHtml(record.id)}"><svg><use href="#i-trash"></use></svg>Eliminar</button>` : '<span></span>'}
      </div>
    </article>
  `).join('');

  bindRecordActions(body);
  bindRecordActions(cards);
}

function canDeleteRecord(record) {
  const user = currentUser();
  return Boolean(user && record?.createdByUid && record.createdByUid === user.uid);
}

function bindRecordActions(root) {
  root.querySelectorAll('[data-detail]').forEach(button => button.addEventListener('click', () => openDetail(button.dataset.detail)));
  root.querySelectorAll('[data-delete]').forEach(button => button.addEventListener('click', () => deleteRecord(button.dataset.delete)));
}

$('#historySearch')?.addEventListener('input', renderHistory);
$('#historyDateFilter')?.addEventListener('change', renderHistory);
$('#activityFilter')?.addEventListener('change', renderHistory);
$('#historyOperatorFilter')?.addEventListener('change', renderHistory);
$('#clearHistoryFilters')?.addEventListener('click', () => {
  $('#historySearch').value = '';
  $('#historyDateFilter').value = '';
  $('#activityFilter').value = '';
  $('#historyOperatorFilter').value = '';
  renderHistory();
});

async function deleteRecord(id) {
  if (!confirm('¿Eliminar este parte? Esta acción también lo eliminará de los dispositivos sincronizados.')) return;
  await state.deleteRecord(id);
  renderHistory();
  renderLocations();
  showToast('Parte eliminado', 'El registro fue retirado del historial.');
}

function openDetail(id) {
  const record = state.records.find(item => item.id === id);
  if (!record) return;

  const fields = {
    Fecha: formatDate(record.fecha),
    Operador: record.operador || '—',
    Máquina: record.maquina || '—',
    Turno: record.turno || '—',
    Especie: record.especie || '—',
    Actividad: record.actividad || '—',
    'Horas trabajadas': `${formatNumber(record.horas, 1)} h`,
    'Árboles procesados': formatNumber(record.arboles),
    Rendimiento: `${formatNumber(record.horas ? record.arboles / record.horas : 0, 1)} árb/h`,
    Carros: formatNumber(record.carros),
    Combustible: `${formatNumber(record.combustible, 1)} L`,
    Hidráulico: `${formatNumber(record.hidraulico, 1)} L`,
    GPS: record.gps ? `${record.gps.latitude.toFixed(6)}, ${record.gps.longitude.toFixed(6)} (±${Math.round(record.gps.accuracy)} m)` : 'Sin ubicación',
    Observaciones: record.observaciones || 'Sin observaciones'
  };

  $('#detailContent').innerHTML = `
    <span class="detail-eyebrow">DETALLE DEL PARTE</span>
    <h2 class="detail-title">${escapeHtml(record.monte)} · ${escapeHtml(record.maquina)}</h2>
    <p class="detail-subtitle">Registrado ${formatDateTime(record.createdAt)} por ${escapeHtml(record.operador || 'Operador')}.</p>
    <div class="detail-grid">${Object.entries(fields).map(([label, value]) => `<article><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></article>`).join('')}</div>
    ${record.gps ? `<a class="btn btn-primary detail-map" href="${mapUrl(record.gps)}" target="_blank" rel="noopener"><svg><use href="#i-pin"></use></svg> Abrir ubicación en el mapa</a>` : ''}
  `;
  $('#detailModal').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeDetail() {
  $('#detailModal').classList.add('hidden');
  document.body.style.overflow = '';
}

$('#detailClose')?.addEventListener('click', closeDetail);
$('#detailModal')?.addEventListener('click', event => {
  if (event.target.id === 'detailModal') closeDetail();
});
window.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !$('#detailModal').classList.contains('hidden')) closeDetail();
});

$('#exportBtn')?.addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(state.records, null, 2)], { type: 'application/json' });
  const anchor = document.createElement('a');
  anchor.href = URL.createObjectURL(blob);
  anchor.download = `partes-forestales-${todayKey()}.json`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(anchor.href), 700);
  showToast('Archivo preparado', 'Se descargó una copia JSON del historial.');
});

function mapUrl(gps) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${gps.latitude},${gps.longitude}`)}`;
}

function renderGpsState(message = '') {
  const stateBox = $('#gpsState');
  const coordinates = $('#gpsCoordinates');
  const link = $('#gpsPreviewLink');
  const pin = $('#gpsMapPin');
  const mapText = $('#mapStatusText');
  const button = $('#gpsCaptureBtn');
  if (!stateBox) return;

  stateBox.className = 'gps-state';
  pin?.classList.toggle('active', Boolean(currentGps));

  if (currentGps) {
    stateBox.classList.add('success', 'locked');
    stateBox.innerHTML = '<strong>Ubicación registrada y bloqueada</strong><small>Estas coordenadas no pueden modificarse dentro del parte.</small>';
    coordinates.classList.remove('hidden');
    coordinates.innerHTML = `
      <div><span>Latitud</span><strong>${currentGps.latitude.toFixed(6)}</strong></div>
      <div><span>Longitud</span><strong>${currentGps.longitude.toFixed(6)}</strong></div>
      <div><span>Precisión</span><strong>±${Math.round(currentGps.accuracy)} m</strong></div>
    `;
    link.href = mapUrl(currentGps);
    link.classList.remove('hidden');
    mapText.textContent = `Ubicación bloqueada · ±${Math.round(currentGps.accuracy)} m`;
    if (button) {
      button.disabled = true;
      button.classList.add('gps-locked-button');
      button.innerHTML = '<svg><use href="#i-lock"></use></svg> Ubicación bloqueada';
    }
  } else {
    stateBox.classList.add(message ? 'error' : 'idle');
    stateBox.innerHTML = `<strong>${escapeHtml(message || 'Ubicación pendiente')}</strong><small>${message ? 'Revisa el permiso y vuelve a intentarlo.' : 'Debes obtener la ubicación actual para continuar.'}</small>`;
    coordinates.classList.add('hidden');
    link.classList.add('hidden');
    mapText.textContent = message || 'Esperando ubicación';
    if (button) {
      button.disabled = gpsInProgress;
      button.classList.remove('gps-locked-button');
      if (!gpsInProgress) button.innerHTML = '<svg><use href="#i-pin"></use></svg> Obtener ubicación actual';
    }
  }
}

function captureGps(automatic = false) {
  if (currentGps) {
    showToast('Ubicación bloqueada', 'La captura ya quedó asociada al parte y no puede modificarse.');
    return;
  }
  if (gpsInProgress) return;
  const button = $('#gpsCaptureBtn');

  if (!navigator.geolocation) {
    renderGpsState('Este dispositivo no admite ubicación GPS');
    updateGpsSystem(false);
    return;
  }

  gpsInProgress = true;
  if (button) {
    button.disabled = true;
    button.innerHTML = '<svg><use href="#i-refresh"></use></svg> Buscando ubicación…';
  }
  const stateBox = $('#gpsState');
  stateBox.className = 'gps-state loading';
  stateBox.innerHTML = `<strong>Buscando ubicación actual…</strong><small>${automatic ? 'Mantén activa la ubicación del teléfono.' : 'Esto puede demorar algunos segundos.'}</small>`;
  $('#mapStatusText').textContent = 'Buscando señal GPS…';

  const finish = () => {
    gpsInProgress = false;
    renderGpsState();
  };

  navigator.geolocation.getCurrentPosition(position => {
    const capturedAt = new Date().toISOString();
    currentGps = Object.freeze({
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      accuracy: position.coords.accuracy,
      altitude: position.coords.altitude,
      heading: position.coords.heading,
      speed: position.coords.speed,
      positionTimestamp: new Date(position.timestamp || Date.now()).toISOString(),
      capturedAt
    });
    updateGpsSystem(true);
    scheduleDraftSave();
    finish();
  }, error => {
    const messages = {
      1: 'Permiso de ubicación denegado',
      2: 'No se pudo determinar la ubicación',
      3: 'La búsqueda de GPS demoró demasiado'
    };
    gpsInProgress = false;
    renderGpsState(messages[error.code] || 'No se pudo obtener la ubicación');
    updateGpsSystem(false);
  }, {
    enableHighAccuracy: true,
    timeout: 20000,
    maximumAge: 0
  });
}

function updateGpsSystem(ok) {
  $('#gpsSystemStatus').textContent = ok ? 'Disponible' : 'Revisar permiso';
  $('#gpsStatusDot').classList.toggle('ok', ok);
}

$('#gpsCaptureBtn')?.addEventListener('click', () => captureGps(false));

function renderLocations() {
  const records = state.records.filter(record => record.gps);
  const list = $('#locationList');
  $('#gpsRecordCount').textContent = formatNumber(records.length);
  $('#gpsAverageAccuracy').textContent = records.length
    ? `±${Math.round(records.reduce((sum, record) => sum + (Number(record.gps.accuracy) || 0), 0) / records.length)} m`
    : '—';
  $('#gpsLastCapture').textContent = records[0]?.gps?.capturedAt ? formatDateTime(records[0].gps.capturedAt) : '—';

  if (!records.length) {
    list.innerHTML = '<div class="empty-state">Todavía no hay partes con ubicación GPS.</div>';
    return;
  }

  list.innerHTML = records.map(record => `
    <article class="location-item">
      <span class="location-pin"><svg><use href="#i-pin"></use></svg></span>
      <div class="location-copy"><strong>${escapeHtml(record.monte)} · ${escapeHtml(record.maquina)}</strong><span>${formatDate(record.fecha)} · ${escapeHtml(record.operador)}</span><small>${record.gps.latitude.toFixed(6)}, ${record.gps.longitude.toFixed(6)} · ±${Math.round(record.gps.accuracy)} m</small></div>
      <a class="btn btn-soft" href="${mapUrl(record.gps)}" target="_blank" rel="noopener"><svg><use href="#i-external"></use></svg> Abrir mapa</a>
    </article>
  `).join('');
}

$('#gpsRefreshBtn')?.addEventListener('click', renderLocations);

function showToast(title, text) {
  window.clearTimeout(toastTimer);
  $('#toastTitle').textContent = title;
  $('#toastText').textContent = text;
  $('#toast').classList.remove('hidden');
  toastTimer = window.setTimeout(() => $('#toast').classList.add('hidden'), 3200);
}

function syncNetworkStatus() {
  if (!navigator.onLine) {
    applyCloudStatus('Sin conexión', false, 'Trabajando con datos locales');
  } else {
    applyCloudStatus(currentCloudStatus.text, currentCloudStatus.ok, currentCloudStatus.detail);
  }
}

function setCloudStatus(text, ok, detail = '') {
  currentCloudStatus = { text, ok, detail: detail || (ok ? 'Datos actualizados' : 'Revisando conexión') };
  syncNetworkStatus();
}

function applyCloudStatus(text, ok, detail) {
  const network = $('#networkStatus');
  network.classList.toggle('offline', !ok || !navigator.onLine);
  network.querySelector('b').textContent = text;
  $('#lastSyncLabel').textContent = detail;
  $('#sidebarSyncTitle').textContent = navigator.onLine ? text : 'Sin conexión';
  $('#sidebarSyncText').textContent = navigator.onLine ? detail : 'Los cambios quedarán pendientes';
  $('#cloudSystemStatus').textContent = text;
}

window.addEventListener('online', () => {
  syncNetworkStatus();
  if (window.LubaydCloud?.available && !cloudUnsubscribe) startCloudSync();
});
window.addEventListener('offline', syncNetworkStatus);

function closeSidebar() {
  $('#sidebar').classList.remove('open');
  $('#sidebarOverlay').classList.remove('show');
}

$('#menuBtn')?.addEventListener('click', () => {
  $('#sidebar').classList.toggle('open');
  $('#sidebarOverlay').classList.toggle('show');
});
$('#sidebarOverlay')?.addEventListener('click', closeSidebar);

window.addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  deferredInstall = event;
  $('#installBtn').classList.remove('hidden');
});

$('#installBtn')?.addEventListener('click', async () => {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  await deferredInstall.userChoice;
  deferredInstall = null;
  $('#installBtn').classList.add('hidden');
});

window.addEventListener('appinstalled', () => $('#installBtn').classList.add('hidden'));

if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register('./service-worker.js');
      if (registration.waiting) {
        waitingWorker = registration.waiting;
        $('#updateBanner').classList.remove('hidden');
      }
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            waitingWorker = worker;
            $('#updateBanner').classList.remove('hidden');
          }
        });
      });
    } catch (error) {
      console.error('Registro PWA:', error);
    }
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload());
}

$('#updateBtn')?.addEventListener('click', () => waitingWorker?.postMessage({ type: 'SKIP_WAITING' }));

async function startCloudSync() {
  if (!currentUser()) {
    setCloudStatus('Sesión requerida', false, 'Inicia sesión para sincronizar');
    return;
  }
  if (!window.LubaydCloud?.available) {
    setCloudStatus('Solo local', false, 'Firebase no está disponible');
    return;
  }

  setCloudStatus('Conectando…', false, 'Iniciando sincronización segura');
  try {
    cloudUnsubscribe?.();
    cloudUnsubscribe = window.LubaydCloud.subscribe((records, metadata) => {
      state.save(records);
      renderAll();
      if ($('#historial')?.classList.contains('active')) renderHistory();
      if ($('#ubicaciones')?.classList.contains('active')) renderLocations();
      if (typeof window.renderCharts === 'function' && $('#graficos')?.classList.contains('active')) window.renderCharts();

      const detail = metadata.fromCache ? 'Mostrando caché local' : `Actualizado ${formatTime(new Date())}`;
      setCloudStatus(metadata.hasPendingWrites ? 'Sincronizando…' : (metadata.fromCache ? 'Datos locales' : 'Sincronizado'), !metadata.hasPendingWrites, detail);
    }, error => {
      console.error('Escucha Firestore:', error);
      setCloudStatus('Error de sincronización', false, 'Los datos locales siguen disponibles');
    });
  } catch (error) {
    console.error('Inicio Firestore:', error);
    setCloudStatus('Pendiente', false, 'No se pudo iniciar la nube');
  }
}

window.addEventListener('lubayd-firebase-ready', () => { if (currentUser()) startCloudSync(); });
window.addEventListener('lubayd-firebase-error', () => setCloudStatus('Solo local', false, 'Firebase no está disponible'));

function todayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function parseRecordDate(value) {
  if (!value) return null;
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(value) {
  const date = parseRecordDate(value);
  return date ? date.toLocaleDateString('es-UY') : '—';
}

function formatDateTime(value) {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('es-UY', { dateStyle: 'short', timeStyle: 'short' });
}

function formatTime(date) {
  return date.toLocaleTimeString('es-UY', { hour: '2-digit', minute: '2-digit' });
}

function formatNumber(value, digits = 0) {
  return Number(value || 0).toLocaleString('es-UY', { maximumFractionDigits: digits, minimumFractionDigits: digits > 0 ? 0 : 0 });
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[character]));
}

syncNetworkStatus();
const initialView = new URLSearchParams(window.location.search).get('view');
let initialViewApplied = false;
window.addEventListener('lubayd-auth-changed', event => {
  if (!initialViewApplied && event.detail?.user && initialView && viewMeta[initialView]) {
    initialViewApplied = true;
    window.setTimeout(() => showView(initialView), 0);
  }
});
if (window.LubaydCurrentUser) handleAuthChange(window.LubaydCurrentUser);
