const FALLBACK_TIMEZONES = [
  'America/Los_Angeles', 'America/Denver', 'America/Chicago',
  'America/New_York', 'America/Phoenix', 'Pacific/Honolulu',
  'Europe/London', 'UTC',
];

export class CalendarComponent {
  constructor(container, options = {}) {
    this.container = container;
    this.proxyUrl = options.proxyUrl || '';
    this.onBook = options.onBook || (() => {});
    this.calendarId = options.calendarId || '';

    this.selectedDate = null;
    this.selectedSlot = null;
    this.currentMonth = new Date();
    this.currentMonth.setDate(1);
    this.slots = {};
    this.loading = false;
    this.loadError = '';
    this._fetchRequestId = 0;
    this.useDemo = !this.proxyUrl;
    this.timeFormat = options.timeFormat === '24h' ? '24h' : '12h';
    this.selectedTimezone =
      options.defaultTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Los_Angeles';
    this.timezoneOptions = this._buildTimezoneOptions(this.selectedTimezone);
  }

  setCalendarId(id) {
    this.calendarId = id || '';
  }

  async render({ skipFetch = false } = {}) {
    this.container.innerHTML = '';
    if (!skipFetch) {
      if (this.useDemo) {
        this._generateDemoSlots();
      } else {
        await this._fetchSlots();
      }
    }
    this._renderCalendar();
  }

  async refreshAvailability({ preserveDate = false, clearSelectedSlot = false } = {}) {
    const prevDate = this.selectedDate;
    const prevSlotStart = this.selectedSlot?.startTime || '';

    if (!this.useDemo) await this._fetchSlots();
    else this._generateDemoSlots();

    if (preserveDate && prevDate && this.slots[prevDate]?.length) {
      this.selectedDate = prevDate;
      if (!clearSelectedSlot && prevSlotStart)
        this.selectedSlot = this.slots[prevDate].find(s => s.startTime === prevSlotStart) || null;
      else this.selectedSlot = null;
    } else {
      this.selectedDate = null;
      this.selectedSlot = null;
    }
    this._renderCalendar();
  }

  async changeMonth(delta) {
    this.currentMonth.setMonth(this.currentMonth.getMonth() + delta);
    this.selectedDate = null;
    this.selectedSlot = null;
    if (!this.useDemo) await this._fetchSlots();
    else this._generateDemoSlots();
    this._renderCalendar();
  }

  // ─── Private ───
  _generateDemoSlots() {
    const now = new Date();
    this.slots = {};
    for (let i = 0; i < 30; i++) {
      const d = new Date(now);
      d.setDate(d.getDate() + i);
      const key = this._formatDate(d);
      const entries = [];
      for (let h = 9; h < 17; h++) {
        const s = new Date(d); s.setHours(h, 0, 0, 0);
        const e = new Date(s); e.setMinutes(30);
        entries.push({ startTime: s.toISOString(), endTime: e.toISOString() });
      }
      this.slots[key] = entries;
    }
  }

  async _fetchSlots() {
    const reqId = ++this._fetchRequestId;
    this.loading = true;
    this.loadError = '';

    this.container.innerHTML = `
      <div class="loading-overlay">
        <div class="spinner"></div>
        <span>Loading available times...</span>
      </div>`;

    try {
      const startDate = new Date(this.currentMonth);
      const endDate = new Date(this.currentMonth);
      endDate.setDate(endDate.getDate() + 30);

      const q = new URLSearchParams({
        startDate: this._formatDate(startDate),
        endDate: this._formatDate(endDate),
      });
      if (this.selectedTimezone) q.set('timezone', this.selectedTimezone);
      if (this.calendarId) q.set('calendarId', this.calendarId);

      const resp = await fetch(`${this.proxyUrl}/api/free-slots?${q}`);
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`HTTP ${resp.status}: ${text.substring(0, 200)}`);
      }
      const data = await resp.json();
      if (reqId !== this._fetchRequestId) return;
      this.slots = this._normalizeSlots(data);
    } catch (err) {
      if (reqId !== this._fetchRequestId) return;
      this.loadError = err?.message || 'Unable to load calendar slots.';
      console.error('[Calendar] Error:', err);
    } finally {
      this.loading = false;
    }
  }

  _normalizeSlots(payload) {
    const byDate = {};
    const seen = new Set();

    const visit = (collection) => {
      if (!collection) return;
      if (Array.isArray(collection)) {
        collection.forEach(item => _append(item));
        return;
      }
      if (typeof collection !== 'object') return;
      for (const [key, val] of Object.entries(collection)) {
        if (['traceId', 'message', 'error', 'meta', 'metadata'].includes(key)) continue;
        if (key === 'data' || key === 'slots') {
          visit(val);
        } else if (Array.isArray(val)) {
          val.forEach(item => _append(item, key));
        } else if (val && typeof val === 'object' && Array.isArray(val.slots)) {
          val.slots.forEach(item => _append(item, key));
        }
      }
    };

    const _append = (item, dateKeyHint) => {
      let start = '';
      let end = '';
      if (typeof item === 'string') {
        // GHL free-slots returns each day's `slots` as an array of ISO time strings
        start = item.trim();
      } else if (item && typeof item === 'object') {
        start = item.startTime || item.start || item.time || item.start_time || '';
        end = item.endTime || item.end || item.end_time || '';
      } else {
        return;
      }
      if (!start) return;
      if (typeof start === 'string') start = start.trim();

      let dateKey;
      if (dateKeyHint && /^\d{4}-\d{2}-\d{2}$/.test(String(dateKeyHint).trim())) {
        dateKey = String(dateKeyHint).trim();
      } else {
        const d = new Date(start);
        if (!Number.isFinite(d.getTime())) return;
        dateKey = this._getDateKeyInTz(d, this.selectedTimezone);
      }

      const dedupeKey = `${dateKey}::${start}`;
      if (seen.has(dedupeKey)) return;
      seen.add(dedupeKey);

      if (!Array.isArray(byDate[dateKey])) byDate[dateKey] = [];
      byDate[dateKey].push({ startTime: start, endTime: end });
    };

    visit(payload);
    if (payload?.data) visit(payload.data);

    for (const key of Object.keys(byDate)) {
      byDate[key].sort((a, b) => (Date.parse(a.startTime) || 0) - (Date.parse(b.startTime) || 0));
    }
    return byDate;
  }

  _renderCalendar() {
    this.container.innerHTML = '';

    const year = this.currentMonth.getFullYear();
    const month = this.currentMonth.getMonth();
    const monthName = this.currentMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    const todayKey = this._getDateKeyInTz(new Date(), this.selectedTimezone);

    const shell = document.createElement('section');
    shell.className = 'calendar-shell';

    const header = document.createElement('div');
    header.className = 'calendar-header';
    const monthLabel = document.createElement('span');
    monthLabel.className = 'calendar-month';
    monthLabel.textContent = monthName;

    const nav = document.createElement('div');
    nav.className = 'calendar-nav';
    const prevBtn = document.createElement('button'); prevBtn.type = 'button'; prevBtn.setAttribute('aria-label', 'Previous month');
    prevBtn.innerHTML = '\u2039';
    prevBtn.addEventListener('click', () => this.changeMonth(-1));
    const nextBtn = document.createElement('button'); nextBtn.type = 'button'; nextBtn.setAttribute('aria-label', 'Next month');
    nextBtn.innerHTML = '\u203A';
    nextBtn.addEventListener('click', () => this.changeMonth(1));
    nav.append(prevBtn, nextBtn);
    header.append(monthLabel, nav);
    shell.appendChild(header);

    if (this.loadError) {
      const errBanner = document.createElement('div');
      errBanner.className = 'calendar-error';
      errBanner.textContent = this.loadError;
      shell.appendChild(errBanner);
    }

    const body = document.createElement('div');
    body.className = 'calendar-body';

    const dateCol = document.createElement('div');
    dateCol.className = 'calendar-date-column';

    const grid = document.createElement('div');
    grid.className = 'calendar-grid';
    ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].forEach(day => {
      const dh = document.createElement('div'); dh.className = 'calendar-day-header'; dh.textContent = day;
      grid.appendChild(dh);
    });

    const firstDow = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    for (let i = 0; i < firstDow; i++) {
      const empty = document.createElement('div'); empty.className = 'calendar-day empty';
      grid.appendChild(empty);
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const date = new Date(year, month, day);
      const dateStr = this._formatDate(date);
      const hasSlots = this.slots[dateStr]?.length > 0;
      const isDisabled = !hasSlots;
      const isToday = dateStr === todayKey;
      const isSelected = this.selectedDate === dateStr;

      const dayEl = document.createElement('button');
      dayEl.type = 'button'; dayEl.className = 'calendar-day';
      dayEl.textContent = String(day);
      dayEl.setAttribute('aria-label', `Select ${dateStr}`);
      if (isDisabled) dayEl.classList.add('disabled');
      if (hasSlots) dayEl.classList.add('has-slots');
      if (isToday) dayEl.classList.add('today');
      if (isSelected) dayEl.classList.add('selected');
      if (isDisabled) dayEl.disabled = true;
      else {
        dayEl.addEventListener('click', () => {
          const prev = grid.querySelector('.calendar-day.selected');
          if (prev) prev.classList.remove('selected');
          dayEl.classList.add('selected');
          this.selectedDate = dateStr;
          this.selectedSlot = null;
          this._renderTimeSlots();
          const area = this.container.querySelector('#time-slots-area');
          if (area && window.matchMedia('(max-width: 860px)').matches)
            area.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });
      }
      grid.appendChild(dayEl);
    }

    dateCol.appendChild(grid);
    const timeCol = document.createElement('div');
    timeCol.id = 'time-slots-area';
    timeCol.className = 'time-slots-column';
    body.append(dateCol, timeCol);
    shell.appendChild(body);
    this.container.appendChild(shell);

    this._renderTimeSlots();
    this._renderTimezonePicker();
  }

  _renderTimeSlots() {
    const area = this.container.querySelector('#time-slots-area');
    if (!area) return;
    area.innerHTML = '';

    const toolbar = document.createElement('div');
    toolbar.className = 'time-slots-toolbar';
    const heading = document.createElement('div');
    heading.className = 'time-slots-day';
    heading.textContent = this.selectedDate ? this._formatSelectedDate(this.selectedDate) : 'Select a date';
    toolbar.appendChild(heading);
    toolbar.appendChild(this._renderTimeFormatToggle());
    area.appendChild(toolbar);

    if (!this.selectedDate) {
      const empty = document.createElement('div'); empty.className = 'time-slots-empty';
      empty.textContent = 'Choose a date to view available times.';
      area.appendChild(empty);
      return;
    }

    const daySlots = this.slots[this.selectedDate];
    if (!daySlots?.length) {
      const empty = document.createElement('div'); empty.className = 'time-slots-empty';
      empty.textContent = 'No available times for this date.';
      area.appendChild(empty);
      return;
    }

    const slotGrid = document.createElement('div');
    slotGrid.className = 'time-slots-grid';

    daySlots.forEach(slot => {
      const label = this._formatTime(slot.startTime);
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'time-slot';
      if (this.selectedSlot?.startTime === slot.startTime) btn.classList.add('selected');

      const dot = document.createElement('span'); dot.className = 'time-slot-dot'; dot.setAttribute('aria-hidden', 'true');
      const lbl = document.createElement('span'); lbl.className = 'time-slot-label'; lbl.textContent = label;
      btn.append(dot, lbl);

      btn.addEventListener('click', () => {
        area.querySelectorAll('.time-slot.selected').forEach(b => b.classList.remove('selected'));
        this.selectedSlot = slot;
        btn.classList.add('selected');
        if (!area.querySelector('.calendar-book-btn')) this._showBookButton(area);
      });

      slotGrid.appendChild(btn);
    });

    area.appendChild(slotGrid);
    this._showBookButton(area);
  }

  _showBookButton(area) {
    if (!this.selectedSlot || !this.selectedDate) return;
    // Remove existing book button
    const existing = area.querySelector('.calendar-book-btn');
    if (existing) existing.remove();

    const btn = document.createElement('button');
    btn.className = 'btn-primary calendar-book-btn';
    btn.type = 'button';
    btn.textContent = 'Book My Call \u2192';

    btn.addEventListener('click', async () => {
      if (!this.selectedSlot) return;
      const parsedStart = new Date(this.selectedSlot.startTime);
      const parsedEnd = this.selectedSlot.endTime ? new Date(this.selectedSlot.endTime) : null;

      btn.disabled = true;
      btn.textContent = 'Booking...';
      try {
        await this.onBook({
          date: this.selectedDate,
          time: this._formatTime(this.selectedSlot.startTime),
          startTime: this.selectedSlot.startTime,
          endTime: this.selectedSlot.endTime,
          timezone: this.selectedTimezone,
          startTimeUtc: Number.isFinite(parsedStart.getTime()) ? parsedStart.toISOString() : '',
          endTimeUtc: parsedEnd && Number.isFinite(parsedEnd.getTime()) ? parsedEnd.toISOString() : '',
        });
      } finally {
        btn.disabled = false;
        btn.textContent = 'Book My Call \u2192';
      }
    });

    area.appendChild(btn);
  }

  _renderTimeFormatToggle() {
    const wrap = document.createElement('div');
    wrap.className = 'time-format-toggle';
    [{ value: '12h', label: '12h' }, { value: '24h', label: '24h' }].forEach(f => {
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'time-format-btn';
      if (this.timeFormat === f.value) btn.classList.add('active');
      btn.textContent = f.label;
      btn.addEventListener('click', () => {
        if (this.timeFormat === f.value) return;
        this.timeFormat = f.value;
        this._renderTimeSlots();
      });
      wrap.appendChild(btn);
    });
    return wrap;
  }

  _renderTimezonePicker() {
    const existing = this.container.querySelector('.calendar-timezone');
    if (existing) existing.remove();

    const section = document.createElement('div');
    section.className = 'calendar-timezone';

    const label = document.createElement('label');
    label.className = 'calendar-timezone-label'; label.id = 'calendar-timezone-label';
    label.textContent = 'Time zone';

    // Custom dark dropdown (native <select> popups can't be themed).
    const dd = document.createElement('div'); dd.className = 'tz-dd';

    const trigger = document.createElement('button');
    trigger.type = 'button'; trigger.className = 'tz-dd__trigger';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-labelledby', 'calendar-timezone-label');
    const value = document.createElement('span');
    value.className = 'tz-dd__value';
    value.textContent = this._formatTimezoneLabel(this.selectedTimezone);
    trigger.appendChild(value);

    const panel = document.createElement('div'); panel.className = 'tz-dd__panel'; panel.hidden = true;
    const list = document.createElement('ul'); list.className = 'tz-dd__list'; list.setAttribute('role', 'listbox');

    const buildOptions = () => {
      list.innerHTML = '';
      this.timezoneOptions.forEach(tz => {
        const labelText = this._formatTimezoneLabel(tz);
        const li = document.createElement('li');
        li.className = 'tz-dd__option'; li.setAttribute('role', 'option'); li.tabIndex = -1;
        li.dataset.tz = tz; li.textContent = labelText;
        if (tz === this.selectedTimezone) { li.classList.add('is-selected'); li.setAttribute('aria-selected', 'true'); }
        li.addEventListener('click', () => choose(tz));
        li.addEventListener('keydown', ev => {
          if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); choose(tz); }
          else if (ev.key === 'ArrowDown') { ev.preventDefault(); li.nextElementSibling?.focus(); }
          else if (ev.key === 'ArrowUp') { ev.preventDefault(); li.previousElementSibling?.focus(); }
        });
        list.appendChild(li);
      });
    };

    const onDocDown = e => { if (!dd.contains(e.target)) close(); };
    const onKey = e => { if (e.key === 'Escape') { close(); trigger.focus(); } };
    const open = () => {
      panel.hidden = false; trigger.setAttribute('aria-expanded', 'true'); dd.classList.add('is-open');
      buildOptions();
      const sel = list.querySelector('.is-selected') || list.querySelector('.tz-dd__option');
      sel?.scrollIntoView({ block: 'center' });
      setTimeout(() => sel?.focus(), 0);
      document.addEventListener('mousedown', onDocDown, true);
      document.addEventListener('keydown', onKey, true);
    };
    const close = () => {
      panel.hidden = true; trigger.setAttribute('aria-expanded', 'false'); dd.classList.remove('is-open');
      document.removeEventListener('mousedown', onDocDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
    const choose = async tz => {
      close();
      if (!tz || tz === this.selectedTimezone) return;
      this.selectedTimezone = tz; this.selectedDate = null; this.selectedSlot = null;
      value.textContent = this._formatTimezoneLabel(tz);
      await this.refreshAvailability({ preserveDate: false, clearSelectedSlot: true });
    };

    trigger.addEventListener('click', () => { panel.hidden ? open() : close(); });

    panel.append(list);
    dd.append(trigger, panel);
    section.append(label, dd);
    this.container.appendChild(section);
  }

  _buildTimezoneOptions(selected) {
    const opts = new Set();
    if (selected) opts.add(selected);
    if (typeof Intl.supportedValuesOf === 'function') {
      try { Intl.supportedValuesOf('timeZone').forEach(tz => opts.add(tz)); } catch {}
    }
    FALLBACK_TIMEZONES.forEach(tz => opts.add(tz));
    return [...opts];
  }

  _formatTimezoneLabel(tz) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' })
        .formatToParts(new Date());
      const offset = parts.find(p => p.type === 'timeZoneName')?.value || 'UTC';
      return `${offset} \u2022 ${tz.replaceAll('_', ' ')}`;
    } catch { return tz; }
  }

  _formatSelectedDate(dateKey) {
    const [y, m, d] = dateKey.split('-').map(Number);
    if (!y || !m || !d) return dateKey;
    const date = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    return new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(date);
  }

  _getDateKeyInTz(date, tz) {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
      }).formatToParts(date);
      const y = parts.find(p => p.type === 'year')?.value;
      const m = parts.find(p => p.type === 'month')?.value;
      const d = parts.find(p => p.type === 'day')?.value;
      if (y && m && d) return `${y}-${m}-${d}`;
    } catch {}
    return this._formatDate(date);
  }

  _formatDate(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  _getCachedFormatter() {
    const key = `${this.timeFormat}:${this.selectedTimezone}`;
    if (this._fmtKey !== key) {
      this._fmtKey = key;
      this._fmt = new Intl.DateTimeFormat('en-US', {
        hour: 'numeric', minute: '2-digit', hour12: this.timeFormat === '12h', timeZone: this.selectedTimezone,
      });
    }
    return this._fmt;
  }

  _formatTime(isoString) {
    try {
      const date = new Date(isoString);
      if (!Number.isFinite(date.getTime())) return isoString;
      const formatted = this._getCachedFormatter().format(date);
      return this.timeFormat === '12h' ? formatted.replace(/\sAM$/, ' am').replace(/\sPM$/, ' pm') : formatted;
    } catch { return isoString; }
  }
}
