// Solo Switch - switch a multi-character bot chat into a 1:1 chat and back.
// Mode "card":  copy the chat into a new chat of a separate solo character card, merge back later (optional).
// Mode "focus": stay in the same chat/card and inject an instruction so only one character appears.

import { STRINGS, LANG_LABELS } from './i18n.js';

const MODULE_NAME = 'solo_switch';
const PROMPT_KEY = 'solo_switch_prompt';
const LOG = '[SoloSwitch]';
const LOADED_FLAG = Symbol.for('solo_switch.loaded');
const MAX_LIST = 300;

const DEFAULT_FOCUS_PROMPT = '[OOC: Private one-on-one scene. From now on, only {{focus}} is present with {{user}}. '
    + 'Other characters from the cast do not appear, speak, act, or get narrated unless {{user}} explicitly brings them in; '
    + 'this overrides any other instruction that puts the rest of the cast into the scene. '
    + 'Write only {{focus}}\'s dialogue, actions, and perspective, true to {{focus}}\'s established personality, voice, and relationship with {{user}}. '
    + 'Keep full continuity with earlier events, and keep writing in the same language as the story so far.]';

const NOTE_LINE = 'Additional notes about {{focus}}: {{note}}';

const DEFAULT_BRIDGE_PROMPT = '[OOC: The earlier messages in this chat come from a story with several characters. '
    + 'From now on, the story continues as a one-on-one between {{user}} and {{char}}. '
    + 'Other characters from that story are not present unless {{user}} explicitly brings them in. '
    + 'Keep full continuity with earlier events, and keep writing in the same language as the story so far.]';

// Generation types that must not receive the instruction (background calls of other extensions, impersonation).
const SKIP_GEN_TYPES = new Set(['quiet', 'impersonate']);

const defaultSettings = Object.freeze({
    language: 'auto',
    copyMetadata: true,
    keepAvatars: true,
    bridgeNote: true,
    showChip: true,
    depth: 1,
    focusPrompt: DEFAULT_FOCUS_PROMPT,
    bridgePrompt: DEFAULT_BRIDGE_PROMPT,
    lastTab: 'card',
    knownNames: {},
});

let busy = false;
let currentGenType = null;

// ---------- basics ----------

function ctx() {
    return SillyTavern.getContext();
}

function events() {
    const c = ctx();
    return c.eventTypes ?? c.event_types;
}

function getSettings() {
    const { extensionSettings } = ctx();
    if (!extensionSettings[MODULE_NAME] || typeof extensionSettings[MODULE_NAME] !== 'object') {
        extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    const s = extensionSettings[MODULE_NAME];
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(s, key)) s[key] = structuredClone(defaultSettings[key]);
    }
    if (!s.knownNames || typeof s.knownNames !== 'object' || Array.isArray(s.knownNames)) s.knownNames = {};
    return s;
}

function lang() {
    const chosen = getSettings().language;
    if (chosen && chosen !== 'auto' && STRINGS[chosen]) return chosen;
    let locale = 'en';
    try {
        locale = String(ctx().getCurrentLocale?.() || navigator.language || 'en').toLowerCase();
    } catch { /* ignore */ }
    if (locale.startsWith('ko')) return 'ko';
    if (locale.startsWith('ja')) return 'ja';
    if (locale.startsWith('zh')) return 'zh';
    return 'en';
}

function t(key, vars = {}) {
    const table = STRINGS[lang()] || STRINGS.en;
    let text = table[key] ?? STRINGS.en[key] ?? key;
    for (const [k, v] of Object.entries(vars)) text = text.split(`{${k}}`).join(String(v));
    return text;
}

function esc(text) {
    return String(text ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[ch]));
}

function thumb(avatar) {
    if (!avatar || avatar === 'none') return '';
    try {
        return ctx().getThumbnailUrl('avatar', avatar);
    } catch {
        return '';
    }
}

function avatarHtml(avatar, name, cls = 'ssw-avatar') {
    const url = thumb(avatar);
    const initial = esc(String(name || '?').trim().charAt(0).toUpperCase() || '?');
    return url
        ? `<img class="${cls}" src="${esc(url)}" alt="" loading="lazy" decoding="async">`
        : `<span class="${cls} ssw-avatar-empty">${initial}</span>`;
}

function isGenerating() {
    const stop = document.getElementById('mes_stop');
    return !!stop && getComputedStyle(stop).display !== 'none';
}

/** Runs one switch operation at a time and keeps the UI in sync afterwards. */
async function exclusive(fn) {
    if (busy) {
        toastr.info(t('err_working'));
        return;
    }
    busy = true;
    document.body.classList.add('ssw-busy');
    try {
        await fn();
    } catch (err) {
        console.error(LOG, err);
        toastr.error(t('err_save'));
    } finally {
        busy = false;
        document.body.classList.remove('ssw-busy');
        refreshAll();
    }
}

// ---------- chat state ----------

/** @returns {any|null} validated state of the open chat */
function getState() {
    const meta = ctx().chatMetadata?.[MODULE_NAME];
    if (!meta || typeof meta !== 'object') return null;
    if (meta.mode === 'card' && meta.originFile && (meta.originAvatar || meta.originName)) return meta;
    if (meta.mode === 'focus' && typeof meta.name === 'string' && meta.name.trim()) return meta;
    return null;
}

function currentCharacter() {
    const c = ctx();
    if (c.groupId) return null;
    if (c.characterId === undefined || c.characterId === null) return null;
    return c.characters[c.characterId] ?? null;
}

function findOriginIndex(st) {
    const list = ctx().characters;
    const byAvatar = list.findIndex(ch => ch?.avatar === st.originAvatar);
    if (byAvatar >= 0) return byAvatar;
    const byName = list.map((ch, i) => (ch?.name === st.originName ? i : -1)).filter(i => i >= 0);
    return byName.length === 1 ? byName[0] : -1;
}

function copyMetadataFrom(source) {
    const meta = getSettings().copyMetadata ? structuredClone(source ?? {}) : {};
    delete meta[MODULE_NAME];
    meta.integrity = ctx().uuidv4();
    return meta;
}

function makeHeader(metadata) {
    return { chat_metadata: metadata, user_name: 'unused', character_name: 'unused' };
}

function withAvatar(messages, avatar) {
    if (!getSettings().keepAvatars) return messages;
    const url = thumb(avatar);
    if (!url) return messages;
    for (const m of messages) {
        if (m && !m.is_user && !m.is_system && !m.force_avatar) m.force_avatar = url;
    }
    return messages;
}

async function fetchChatFile(character, fileName) {
    const res = await fetch('/api/chats/get', {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        cache: 'no-cache',
        body: JSON.stringify({ ch_name: character.name, file_name: fileName, avatar_url: character.avatar }),
    });
    if (!res.ok) throw new Error(`get chat failed: ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) return null;
    const [header, ...messages] = data;
    return { header, messages };
}

/** /api/chats/get with no file name creates the card's chat folder if it is missing. */
async function ensureChatFolder(character) {
    try {
        await fetchChatFile(character, '');
    } catch { /* the save call reports real problems */ }
}

async function saveChatFile(character, fileName, header, messages) {
    const res = await fetch('/api/chats/save', {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        cache: 'no-cache',
        body: JSON.stringify({
            ch_name: character.name,
            file_name: fileName,
            chat: [header, ...messages],
            avatar_url: character.avatar,
        }),
    });
    if (!res.ok) {
        let detail = '';
        try { detail = JSON.stringify(await res.json()); } catch { /* ignore */ }
        throw new Error(`save chat failed: ${res.status} ${detail}`);
    }
}

function safeFilePart(text) {
    return String(text).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 60) || 'chat';
}

function newFileName(...parts) {
    const stamp = ctx().humanizedDateTime();
    const tag = Math.random().toString(36).slice(2, 6);
    return `${parts.map(safeFilePart).join(' - ')} - ${stamp}-${tag}`;
}

/** Switch the UI to a given character and chat file. */
async function openChatOf(charIndex, fileName) {
    const c = ctx();
    const target = c.characters[charIndex];
    if (!target) return false;
    target.chat = fileName; // the first load already reads our file
    await c.selectCharacterById(charIndex);
    if (String(ctx().characterId) !== String(charIndex)) return false;
    // openCharacterChat also saves this chat as the card's last chat, so it reopens after a page refresh
    await ctx().openCharacterChat(fileName);
    return ctx().getCurrentChatId() === fileName;
}

function rememberName(avatar, name) {
    const s = getSettings();
    const list = Array.isArray(s.knownNames[avatar]) ? s.knownNames[avatar] : [];
    s.knownNames[avatar] = [name, ...list.filter(n => n !== name)].slice(0, 12);
    ctx().saveSettingsDebounced();
}

// ---------- prompt injection ----------

function buildPromptText() {
    const s = getSettings();
    const st = getState();
    if (st?.mode === 'focus') {
        let text = String(s.focusPrompt || DEFAULT_FOCUS_PROMPT);
        const note = String(st.note ?? '').trim();
        if (note && !text.includes('{{note}}')) text += '\n' + NOTE_LINE;
        return text.split('{{focus}}').join(st.name.trim()).split('{{note}}').join(note);
    }
    if (st?.mode === 'card' && s.bridgeNote) {
        return String(s.bridgePrompt || DEFAULT_BRIDGE_PROMPT);
    }
    return '';
}

function applyPrompt() {
    try {
        const depth = Math.min(100, Math.max(0, Number(getSettings().depth) || 0));
        const IN_CHAT = 1; // extension_prompt_types.IN_CHAT
        const SYSTEM = 0; // extension_prompt_roles.SYSTEM
        const filter = () => !SKIP_GEN_TYPES.has(currentGenType);
        ctx().setExtensionPrompt(PROMPT_KEY, buildPromptText(), IN_CHAT, depth, false, SYSTEM, filter);
    } catch (err) {
        console.warn(LOG, 'prompt update failed', err);
    }
}

// ---------- status chip ----------

function renderChip() {
    document.getElementById('solo_switch_chip')?.remove();
    const st = getState();
    if (!st || !getSettings().showChip) return;
    const sendForm = document.getElementById('send_form');
    if (!sendForm?.parentElement) return;

    const isCard = st.mode === 'card';
    const name = isCard ? st.soloName : st.name;
    const me = currentCharacter();
    const chip = document.createElement('div');
    chip.id = 'solo_switch_chip';
    chip.className = 'ssw-chip-bar';
    chip.innerHTML = `
        ${isCard ? avatarHtml(me?.avatar, name, 'ssw-chip-avatar') : '<span class="ssw-chip-avatar ssw-chip-icon"><i class="fa-solid fa-comment-dots"></i></span>'}
        <span class="ssw-chip-text"><b>1:1 · ${esc(name)}</b><small>${esc(t(isCard ? 'chip_card_hint' : 'chip_focus_hint'))}</small></span>
        <button type="button" class="ssw-chip-back" title="${esc(t('menu_back'))}"><i class="fa-solid fa-arrow-rotate-left"></i><span>${esc(t('chip_back'))}</span></button>`;
    chip.querySelector('.ssw-chip-back').addEventListener('click', () => openBackDialog());
    sendForm.parentElement.insertBefore(chip, sendForm);
}

function renderStatus() {
    const box = document.getElementById('solo_switch_status');
    if (!box) return;
    const st = getState();
    let icon = 'fa-users';
    let title = t('status_none');
    let hint = t('status_none_hint');
    if (st?.mode === 'card') {
        icon = 'fa-id-card';
        title = t('status_card', { name: st.soloName ?? '' });
        hint = t('status_card_hint', { origin: st.originName ?? '' });
    } else if (st?.mode === 'focus') {
        icon = 'fa-comment-dots';
        title = t('status_focus', { name: st.name });
        hint = t('status_focus_hint');
    }
    box.classList.toggle('ssw-status-active', !!st);
    box.innerHTML = `<i class="fa-solid ${icon}"></i><div><b>${esc(title)}</b><small>${esc(hint)}</small></div>`;
    const startBtn = document.getElementById('solo_switch_btn_start');
    const backBtn = document.getElementById('solo_switch_btn_back');
    if (startBtn) startBtn.hidden = !!st;
    if (backBtn) backBtn.hidden = !st;
}

function renderMenu() {
    const label = document.querySelector('#solo_switch_menu_item span');
    if (label) label.textContent = getState() ? t('menu_back') : t('menu_start');
}

function refreshAll() {
    applyPrompt();
    try { renderChip(); } catch (err) { console.warn(LOG, err); }
    try { renderStatus(); } catch (err) { console.warn(LOG, err); }
    try { renderMenu(); } catch (err) { console.warn(LOG, err); }
}

// ---------- popups ----------

function makePopup(root, type, options) {
    const c = ctx();
    const popup = new c.Popup(root, type, '', { leftAlign: true, allowVerticalScrolling: true, ...options });
    popup.dlg?.classList.add('ssw-popup');
    return popup;
}

/** Card list with search. Returns { root, getSelected }. */
function buildCardPicker(candidates, { onPick } = {}) {
    const wrap = document.createElement('div');
    wrap.className = 'ssw-picker';
    wrap.innerHTML = `
        <div class="ssw-search"><i class="fa-solid fa-magnifying-glass"></i><input type="search" class="text_pole" placeholder="${esc(t('search'))}" autocomplete="off"></div>
        <div class="ssw-list" role="listbox"></div>`;
    const input = wrap.querySelector('input');
    const list = wrap.querySelector('.ssw-list');
    let selected = -1;

    const select = (idx) => {
        selected = idx;
        list.querySelectorAll('.ssw-row').forEach(row => {
            const on = Number(row.dataset.idx) === idx;
            row.classList.toggle('ssw-selected', on);
            row.setAttribute('aria-selected', String(on));
        });
    };

    const render = () => {
        const q = input.value.trim().toLowerCase();
        const matches = candidates.filter(({ ch }) => !q || String(ch.name).toLowerCase().includes(q));
        if (!candidates.length || !matches.length) {
            list.innerHTML = `<div class="ssw-empty">${esc(t(candidates.length ? 'no_match' : 'no_cards'))}</div>`;
            return;
        }
        list.innerHTML = matches.slice(0, MAX_LIST).map(({ ch, i }) => `
            <div class="ssw-row${i === selected ? ' ssw-selected' : ''}" role="option" tabindex="0" data-idx="${i}" aria-selected="${i === selected}" title="${esc(ch.avatar)}">
                ${avatarHtml(ch.avatar, ch.name)}
                <span class="ssw-row-name">${esc(ch.name)}</span>
                <i class="fa-solid fa-circle-check ssw-check"></i>
            </div>`).join('');
    };

    list.addEventListener('click', (e) => {
        const row = e.target.closest('.ssw-row');
        if (row) select(Number(row.dataset.idx));
    });
    list.addEventListener('dblclick', (e) => {
        const row = e.target.closest('.ssw-row');
        if (row) { select(Number(row.dataset.idx)); onPick?.(); }
    });
    list.addEventListener('keydown', (e) => {
        const row = e.target.closest('.ssw-row');
        if (!row) return;
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            e.stopPropagation();
            select(Number(row.dataset.idx));
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            const next = e.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling;
            next?.focus();
        }
    });
    input.addEventListener('input', render);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') e.preventDefault();
        if (e.key === 'ArrowDown') { e.preventDefault(); list.querySelector('.ssw-row')?.focus(); }
    });
    render();
    return { root: wrap, getSelected: () => selected, focus: () => input.focus() };
}

function cardCandidates(excludeAvatar) {
    return ctx().characters
        .map((ch, i) => ({ ch, i }))
        .filter(({ ch }) => ch && ch.avatar && ch.avatar !== excludeAvatar)
        .sort((a, b) => String(a.ch.name).localeCompare(String(b.ch.name)));
}

// ---------- start ----------

function preflightStart() {
    const c = ctx();
    if (c.groupId) return t('err_group');
    if (!currentCharacter() || !c.getCurrentChatId()) return t('err_nochar');
    if (getState()) return t('err_already');
    if (isGenerating()) return t('err_busy');
    return '';
}

async function openStartDialog() {
    if (busy) return toastr.info(t('err_working'));
    const problem = preflightStart();
    if (problem) return toastr.warning(problem);

    const c = ctx();
    const s = getSettings();
    const me = currentCharacter();
    const names = Array.isArray(s.knownNames[me.avatar]) ? s.knownNames[me.avatar] : [];
    let tab = s.lastTab === 'focus' ? 'focus' : 'card';
    let popup = null;

    const root = document.createElement('div');
    root.className = 'ssw';
    root.innerHTML = `
        <div class="ssw-head">
            ${avatarHtml(me.avatar, me.name, 'ssw-head-avatar')}
            <div class="ssw-head-text">
                <div class="ssw-title">${esc(t('start_title'))}</div>
                <div class="ssw-sub">${esc(t('start_sub', { card: me.name, n: c.chat.length }))}</div>
            </div>
        </div>
        <div class="ssw-tabs" role="tablist">
            <button type="button" class="ssw-tab" role="tab" data-tab="card"><i class="fa-solid fa-id-card"></i><span>${esc(t('tab_card'))}</span></button>
            <button type="button" class="ssw-tab" role="tab" data-tab="focus"><i class="fa-solid fa-comment-dots"></i><span>${esc(t('tab_focus'))}</span></button>
        </div>
        <div class="ssw-pane" data-pane="card">
            <p class="ssw-desc">${esc(t('tab_card_desc'))}</p>
        </div>
        <div class="ssw-pane" data-pane="focus">
            <p class="ssw-desc">${esc(t('tab_focus_desc'))}</p>
            <label class="ssw-label" for="ssw_focus_name">${esc(t('focus_name'))}</label>
            <input id="ssw_focus_name" type="text" class="text_pole ssw-name" maxlength="80" autocomplete="off" placeholder="${esc(t('focus_name_ph'))}">
            ${names.length ? `<div class="ssw-chips"><span class="ssw-chips-label">${esc(t('recent_names'))}</span>${names.map(n => `<button type="button" class="ssw-namechip" data-name="${esc(n)}">${esc(n)}</button>`).join('')}</div>` : ''}
            <label class="ssw-label" for="ssw_focus_note">${esc(t('focus_note'))} <span class="ssw-opt">${esc(t('focus_note_opt'))}</span></label>
            <textarea id="ssw_focus_note" class="text_pole ssw-note" rows="3" maxlength="2000" placeholder="${esc(t('focus_note_ph'))}"></textarea>
        </div>`;

    const picker = buildCardPicker(cardCandidates(me.avatar), { onPick: () => popup?.completeAffirmative() });
    root.querySelector('[data-pane="card"]').appendChild(picker.root);
    const nameInput = root.querySelector('.ssw-name');
    const noteInput = root.querySelector('.ssw-note');

    const showTab = (next) => {
        tab = next;
        root.querySelectorAll('.ssw-tab').forEach(b => {
            const on = b.dataset.tab === tab;
            b.classList.toggle('ssw-tab-on', on);
            b.setAttribute('aria-selected', String(on));
        });
        root.querySelectorAll('.ssw-pane').forEach(p => { p.hidden = p.dataset.pane !== tab; });
    };
    root.querySelectorAll('.ssw-tab').forEach(b => b.addEventListener('click', () => {
        showTab(b.dataset.tab);
        (tab === 'card' ? picker.focus : () => nameInput.focus())();
    }));
    root.querySelectorAll('.ssw-namechip').forEach(b => b.addEventListener('click', () => {
        nameInput.value = b.dataset.name;
        nameInput.focus();
    }));
    showTab(tab);

    const validate = () => {
        if (tab === 'card') {
            const idx = picker.getSelected();
            return idx >= 0 && ctx().characters[idx] ? '' : t('err_nopick');
        }
        return nameInput.value.trim() ? '' : t('err_noname');
    };

    popup = makePopup(root, c.POPUP_TYPE.CONFIRM, {
        okButton: t('btn_switch'),
        cancelButton: t('btn_cancel'),
        onClosing: (p) => {
            if (p.result !== ctx().POPUP_RESULT.AFFIRMATIVE) return true;
            const err = validate();
            if (err) toastr.warning(err);
            return !err;
        },
    });
    const result = await popup.show();
    if (result !== c.POPUP_RESULT.AFFIRMATIVE) return;

    s.lastTab = tab;
    ctx().saveSettingsDebounced();

    // The state may have changed while the dialog was open.
    const late = preflightStart();
    if (late) return toastr.warning(late);

    if (tab === 'card') {
        await exclusive(() => startCardMode(picker.getSelected()));
    } else {
        await exclusive(() => startFocusMode(nameInput.value.trim(), noteInput.value));
    }
}

async function startCardMode(soloIndex) {
    const c = ctx();
    const origin = currentCharacter();
    const solo = c.characters[soloIndex];
    const originFile = c.getCurrentChatId();
    if (!origin || !solo || !originFile) return toastr.warning(t('err_nochar'));

    await c.saveChat();
    const messages = withAvatar(structuredClone(ctx().chat), origin.avatar);
    const meta = copyMetadataFrom(ctx().chatMetadata);
    meta[MODULE_NAME] = {
        mode: 'card',
        soloName: solo.name,
        soloAvatar: solo.avatar,
        originAvatar: origin.avatar,
        originName: origin.name,
        originFile,
        originLength: messages.length,
        baseLength: messages.length,
        createdAt: Date.now(),
    };
    const fileName = newFileName(solo.name, `1on1 from ${origin.name}`);
    await ensureChatFolder(solo);
    await saveChatFile(solo, fileName, makeHeader(meta), messages);

    if (!await openChatOf(soloIndex, fileName)) return toastr.error(t('err_switch'));
    toastr.success(t('ok_card', { name: solo.name }));
}

async function startFocusMode(name, note) {
    const c = ctx();
    const me = currentCharacter();
    if (!me) return;
    c.chatMetadata[MODULE_NAME] = {
        mode: 'focus',
        name: String(name).trim().slice(0, 80),
        note: String(note ?? '').slice(0, 2000),
        startIndex: c.chat.length,
        createdAt: Date.now(),
    };
    await c.saveMetadata();
    rememberName(me.avatar, name);
    toastr.success(t('ok_focus', { name }));
}

// ---------- back ----------

async function openBackDialog() {
    if (busy) return toastr.info(t('err_working'));
    const c = ctx();
    const st = getState();
    if (!st) return toastr.info(t('err_notsolo'));
    if (isGenerating()) return toastr.warning(t('err_busy'));

    const isCard = st.mode === 'card';
    const name = isCard ? st.soloName : st.name;
    const base = Number(isCard ? st.baseLength : st.startIndex);
    const newCount = Math.max(0, c.chat.length - (Number.isFinite(base) ? base : c.chat.length));
    const A = c.POPUP_RESULT.CUSTOM1;
    const B = c.POPUP_RESULT.CUSTOM2;

    const options = isCard
        ? [
            { result: A, icon: 'fa-link', title: t('opt_merge'), desc: t('opt_merge_desc', { n: newCount }), primary: true },
            { result: B, icon: 'fa-box-archive', title: t('opt_keep'), desc: t('opt_keep_desc', { name }) },
        ]
        : [
            { result: A, icon: 'fa-check', title: t('opt_stay'), desc: t('opt_stay_desc'), primary: true },
            { result: B, icon: 'fa-scissors', title: t('opt_split'), desc: t('opt_split_desc', { n: newCount }), warn: newCount > 0 },
        ];

    const me = currentCharacter();
    const root = document.createElement('div');
    root.className = 'ssw';
    root.innerHTML = `
        <div class="ssw-head">
            ${isCard ? avatarHtml(me?.avatar, name, 'ssw-head-avatar') : '<span class="ssw-head-avatar ssw-avatar-empty"><i class="fa-solid fa-comment-dots"></i></span>'}
            <div class="ssw-head-text">
                <div class="ssw-title">${esc(t('back_title'))}</div>
                <div class="ssw-sub">${esc(t(isCard ? 'back_sub_card' : 'back_sub_focus', { name, n: newCount }))}</div>
            </div>
        </div>
        <div class="ssw-options">
            ${options.map(o => `
            <button type="button" class="ssw-option${o.primary ? ' ssw-option-primary' : ''}${o.warn ? ' ssw-option-warn' : ''}" data-result="${o.result}">
                <span class="ssw-option-icon"><i class="fa-solid ${o.icon}"></i></span>
                <span class="ssw-option-text"><b>${esc(o.title)}</b><small>${esc(o.desc)}</small></span>
                <i class="fa-solid fa-chevron-right ssw-option-go"></i>
            </button>`).join('')}
        </div>`;

    const popup = makePopup(root, c.POPUP_TYPE.TEXT, { okButton: false, cancelButton: t('btn_cancel'), defaultResult: c.POPUP_RESULT.CANCELLED });
    root.querySelectorAll('.ssw-option').forEach(btn => btn.addEventListener('click', () => popup.complete(Number(btn.dataset.result))));
    const result = await popup.show();
    if (result !== A && result !== B) return;

    if (isCard) {
        await exclusive(() => backFromCard(st, result === A));
    } else if (result === A) {
        await exclusive(() => backFromFocusStay());
    } else {
        if (newCount > 0) {
            const ok = await ctx().Popup.show.confirm(t('opt_split'), t('confirm_split', { n: newCount }));
            if (!ok) return;
        }
        await exclusive(() => backFromFocusSplit(st));
    }
}

/** Asks the user to pick the multi-bot card when it was renamed or cannot be matched. */
async function pickOriginCard(st) {
    const c = ctx();
    const me = currentCharacter();
    let popup = null;
    const picker = buildCardPicker(cardCandidates(me?.avatar), { onPick: () => popup?.completeAffirmative() });
    const root = document.createElement('div');
    root.className = 'ssw';
    root.innerHTML = `
        <div class="ssw-head"><span class="ssw-head-avatar ssw-avatar-empty"><i class="fa-solid fa-users"></i></span>
            <div class="ssw-head-text"><div class="ssw-title">${esc(t('pick_origin_title'))}</div><div class="ssw-sub">${esc(st.originName ?? '')}</div></div></div>
        <p class="ssw-desc">${esc(t('pick_origin_desc'))}</p>`;
    root.appendChild(picker.root);
    popup = makePopup(root, c.POPUP_TYPE.CONFIRM, {
        okButton: t('btn_pick'),
        cancelButton: t('btn_cancel'),
        onClosing: (p) => p.result !== ctx().POPUP_RESULT.AFFIRMATIVE || picker.getSelected() >= 0,
    });
    const result = await popup.show();
    return result === c.POPUP_RESULT.AFFIRMATIVE ? picker.getSelected() : -1;
}

async function backFromCard(st, merge) {
    let originIndex = findOriginIndex(st);
    if (originIndex < 0) {
        toastr.warning(t('err_origin_missing'));
        originIndex = await pickOriginCard(st);
        if (originIndex < 0) return;
    }
    const c = ctx();
    const origin = c.characters[originIndex];

    await c.saveChat();
    const file = await fetchChatFile(origin, st.originFile);
    if (!file) return toastr.error(t('err_origin_file'));

    let merged = 0;
    if (merge) {
        const base = Math.max(0, Number(st.baseLength) || 0);
        const newMessages = withAvatar(structuredClone(ctx().chat.slice(base)), st.soloAvatar ?? currentCharacter()?.avatar);
        if (newMessages.length > 0) {
            if (file.messages.length !== Number(st.originLength)) toastr.warning(t('warn_origin_changed'));
            const all = [...file.messages, ...newMessages];
            await saveChatFile(origin, st.originFile, file.header, all);
            merged = newMessages.length;
            // Remember what was merged so a second merge does not duplicate messages.
            ctx().chatMetadata[MODULE_NAME] = {
                ...st,
                originAvatar: origin.avatar,
                originName: origin.name,
                baseLength: ctx().chat.length,
                originLength: all.length,
                mergedAt: Date.now(),
            };
            await ctx().saveMetadata();
        }
    }

    if (!await openChatOf(originIndex, st.originFile)) return toastr.error(t('err_switch'));
    if (!merge) toastr.success(t('ok_kept'));
    else toastr.success(merged ? t('ok_merged', { n: merged }) : t('ok_nothing'));
}

async function backFromFocusStay() {
    const c = ctx();
    delete c.chatMetadata[MODULE_NAME];
    await c.saveMetadata();
    toastr.success(t('ok_stay'));
}

async function backFromFocusSplit(st) {
    const c = ctx();
    const me = currentCharacter();
    if (!me) return;

    await c.saveChat();
    const chat = ctx().chat;
    const start = Math.min(chat.length, Math.max(0, Number(st.startIndex) || 0));
    let archiveName = '';

    if (chat.length > start) {
        // The archive keeps the full history so it can be continued later, still in 1:1 mode.
        const meta = copyMetadataFrom(ctx().chatMetadata);
        meta[MODULE_NAME] = { ...st, archivedFrom: c.getCurrentChatId() };
        archiveName = newFileName(me.name, `1on1 ${st.name}`);
        await saveChatFile(me, archiveName, makeHeader(meta), structuredClone(chat));

        chat.splice(start);
    }

    delete ctx().chatMetadata[MODULE_NAME];
    await ctx().saveChat();
    if (archiveName) {
        // Same signal ST sends after deleting messages, so memory/tracker extensions can catch up.
        await ctx().eventSource.emit(events().MESSAGE_DELETED, ctx().chat.length);
    }
    await ctx().reloadCurrentChat();
    toastr.success(archiveName ? t('ok_split', { file: archiveName }) : t('ok_stay'));
}

// ---------- settings panel, wand menu, commands ----------

function addMenuItem() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById('solo_switch_menu_item')) return;
    const item = document.createElement('div');
    item.id = 'solo_switch_menu_item';
    item.className = 'list-group-item flex-container flexGap5 interactable';
    item.tabIndex = 0;
    item.innerHTML = '<div class="fa-solid fa-user-group extensionsMenuExtensionButton"></div><span></span>';
    const run = () => (getState() ? openBackDialog() : openStartDialog());
    item.addEventListener('click', run);
    item.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
    menu.appendChild(item);
    renderMenu();
}

function buildSettingsPanel(open = false) {
    const container = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!container) return;
    document.getElementById('solo_switch_settings')?.remove();

    const s = getSettings();
    const langOptions = [`<option value="auto">${esc(t('set_lang_auto'))}</option>`]
        .concat(Object.entries(LANG_LABELS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`))
        .join('');
    const toggle = (id, label, hint = '') => `
        <label class="checkbox_label ssw-toggle" for="${id}">
            <input id="${id}" type="checkbox">
            <span>${esc(label)}${hint ? `<small>${esc(hint)}</small>` : ''}</span>
        </label>`;

    const html = `
    <div id="solo_switch_settings" class="extension_settings ssw-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b><i class="fa-solid fa-user-group"></i> ${esc(t('title'))} <span class="ssw-muted">${esc(t('subtitle'))}</span></b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="ssw-section-title">${esc(t('sec_status'))}</div>
                <div id="solo_switch_status" class="ssw-status"></div>
                <div class="ssw-actions">
                    <div id="solo_switch_btn_start" class="menu_button menu_button_icon"><i class="fa-solid fa-arrow-right-arrow-left"></i><span>${esc(t('menu_start'))}</span></div>
                    <div id="solo_switch_btn_back" class="menu_button menu_button_icon"><i class="fa-solid fa-arrow-rotate-left"></i><span>${esc(t('menu_back'))}</span></div>
                </div>

                <div class="ssw-section-title">${esc(t('sec_behavior'))}</div>
                <div class="ssw-field">
                    <label for="solo_switch_language">${esc(t('set_language'))}</label>
                    <select id="solo_switch_language" class="text_pole">${langOptions}</select>
                </div>
                ${toggle('solo_switch_copy_meta', t('set_copy_meta'), t('set_copy_meta_hint'))}
                ${toggle('solo_switch_avatars', t('set_avatar'), t('set_avatar_hint'))}
                ${toggle('solo_switch_bridge', t('set_bridge'))}
                ${toggle('solo_switch_chip_toggle', t('set_chip'))}

                <details class="ssw-details">
                    <summary>${esc(t('sec_prompts'))}</summary>
                    <div class="ssw-field ssw-field-row">
                        <label for="solo_switch_depth">${esc(t('set_depth'))}<small>${esc(t('set_depth_hint'))}</small></label>
                        <input id="solo_switch_depth" class="text_pole" type="number" min="0" max="100" step="1">
                    </div>
                    <div class="ssw-field">
                        <label for="solo_switch_focus_prompt">${esc(t('set_focus_prompt'))}</label>
                        <textarea id="solo_switch_focus_prompt" class="text_pole" rows="6"></textarea>
                    </div>
                    <div class="ssw-field">
                        <label for="solo_switch_bridge_prompt">${esc(t('set_bridge_prompt'))}</label>
                        <textarea id="solo_switch_bridge_prompt" class="text_pole" rows="4"></textarea>
                    </div>
                    <small class="ssw-muted">${esc(t('set_placeholders'))}</small>
                    <div class="ssw-actions"><div id="solo_switch_reset" class="menu_button menu_button_icon"><i class="fa-solid fa-rotate"></i><span>${esc(t('set_reset'))}</span></div></div>
                </details>
            </div>
        </div>
    </div>`;
    container.insertAdjacentHTML('beforeend', html);

    const el = (id) => document.getElementById(id);
    const save = () => { ctx().saveSettingsDebounced(); applyPrompt(); };

    el('solo_switch_language').value = STRINGS[s.language] ? s.language : 'auto';
    el('solo_switch_copy_meta').checked = !!s.copyMetadata;
    el('solo_switch_avatars').checked = !!s.keepAvatars;
    el('solo_switch_bridge').checked = !!s.bridgeNote;
    el('solo_switch_chip_toggle').checked = !!s.showChip;
    el('solo_switch_depth').value = String(s.depth);
    el('solo_switch_focus_prompt').value = s.focusPrompt;
    el('solo_switch_bridge_prompt').value = s.bridgePrompt;

    el('solo_switch_btn_start').addEventListener('click', () => openStartDialog());
    el('solo_switch_btn_back').addEventListener('click', () => openBackDialog());
    el('solo_switch_language').addEventListener('change', (e) => {
        s.language = e.target.value;
        ctx().saveSettingsDebounced();
        buildSettingsPanel(true);
        refreshAll();
    });
    el('solo_switch_copy_meta').addEventListener('change', (e) => { s.copyMetadata = e.target.checked; save(); });
    el('solo_switch_avatars').addEventListener('change', (e) => { s.keepAvatars = e.target.checked; save(); });
    el('solo_switch_bridge').addEventListener('change', (e) => { s.bridgeNote = e.target.checked; save(); });
    el('solo_switch_chip_toggle').addEventListener('change', (e) => { s.showChip = e.target.checked; save(); renderChip(); });
    el('solo_switch_depth').addEventListener('change', (e) => {
        s.depth = Math.min(100, Math.max(0, parseInt(e.target.value, 10) || 0));
        e.target.value = String(s.depth);
        save();
    });
    el('solo_switch_focus_prompt').addEventListener('input', (e) => { s.focusPrompt = e.target.value; save(); });
    el('solo_switch_bridge_prompt').addEventListener('input', (e) => { s.bridgePrompt = e.target.value; save(); });
    el('solo_switch_reset').addEventListener('click', () => {
        s.depth = defaultSettings.depth;
        s.focusPrompt = DEFAULT_FOCUS_PROMPT;
        s.bridgePrompt = DEFAULT_BRIDGE_PROMPT;
        el('solo_switch_depth').value = String(s.depth);
        el('solo_switch_focus_prompt').value = s.focusPrompt;
        el('solo_switch_bridge_prompt').value = s.bridgePrompt;
        save();
    });

    if (open) {
        const drawer = el('solo_switch_settings');
        drawer.querySelector('.inline-drawer-content').style.display = 'block';
        drawer.querySelector('.inline-drawer-icon')?.classList.replace('down', 'up');
        drawer.querySelector('.inline-drawer-icon')?.classList.replace('fa-circle-chevron-down', 'fa-circle-chevron-up');
    }
    renderStatus();
}

function registerCommands() {
    const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = ctx();
    if (!SlashCommandParser?.addCommandObject || !SlashCommand?.fromProps) return;
    const taken = (name) => Object.hasOwn(SlashCommandParser.commands ?? {}, name);

    if (!taken('solo')) {
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'solo',
            callback: async (_args, value) => {
                const name = String(value ?? '').trim();
                if (name && !preflightStart()) {
                    await exclusive(() => startFocusMode(name, ''));
                } else {
                    await openStartDialog();
                }
                return '';
            },
            returns: 'nothing',
            unnamedArgumentList: [
                SlashCommandArgument.fromProps({
                    description: 'character name for one-character mode (optional; opens the dialog when empty)',
                    typeList: ARGUMENT_TYPE.STRING,
                    isRequired: false,
                }),
            ],
            helpString: '<div>Solo Switch: switch to a 1:1 chat. <code>/solo</code> opens the dialog, <code>/solo Arin</code> starts one-character mode with Arin.</div>',
        }));
    }

    if (!taken('solo-back')) {
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'solo-back',
            callback: async () => {
                await openBackDialog();
                return '';
            },
            returns: 'nothing',
            helpString: '<div>Solo Switch: go back from a 1:1 chat to the multi-character bot (asks what to do with the 1:1 messages).</div>',
        }));
    }
}

// ---------- init ----------

function onCharacterRenamed(oldAvatar, newAvatar) {
    const s = getSettings();
    if (oldAvatar && newAvatar && s.knownNames[oldAvatar]) {
        s.knownNames[newAvatar] = s.knownNames[oldAvatar];
        delete s.knownNames[oldAvatar];
        ctx().saveSettingsDebounced();
    }
}

/** ST rewrites the renamed card's past chats; keep our references to that card correct. */
function onRenamedInPastChat(chatData, oldAvatar, newAvatar) {
    const meta = Array.isArray(chatData) ? chatData[0]?.chat_metadata?.[MODULE_NAME] : null;
    if (!meta || meta.mode !== 'card') return;
    const renamed = ctx().characters.find(ch => ch?.avatar === newAvatar);
    if (meta.soloAvatar === oldAvatar) {
        meta.soloAvatar = newAvatar;
        if (renamed) meta.soloName = renamed.name;
    }
}

(function init() {
    if (globalThis[LOADED_FLAG]) return;
    globalThis[LOADED_FLAG] = true;

    const { eventSource } = ctx();
    const ev = events();
    getSettings();

    const on = (name, fn) => {
        if (!name) return;
        eventSource.on(name, (...args) => {
            try { return fn(...args); } catch (err) { console.warn(LOG, err); }
        });
    };

    on(ev.APP_READY, () => {
        addMenuItem();
        buildSettingsPanel();
        registerCommands();
        refreshAll();
    });
    on(ev.CHAT_CHANGED, () => refreshAll());
    on(ev.GENERATION_STARTED, (type) => { currentGenType = type ?? 'normal'; });
    on(ev.GENERATION_AFTER_COMMANDS, () => applyPrompt());
    on(ev.GENERATION_ENDED, () => { currentGenType = null; });
    on(ev.GENERATION_STOPPED, () => { currentGenType = null; });
    on(ev.CHARACTER_RENAMED, onCharacterRenamed);
    on(ev.CHARACTER_RENAMED_IN_PAST_CHAT, onRenamedInPastChat);
    console.log(LOG, 'loaded');
})();
