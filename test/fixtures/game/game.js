// A small stand-in for a Stake Engine game, used by the tests and the demo. It follows the RGS contract
// the way a game should. bugs.json, next to this file, switches on mistakes the tests expect to be caught.

(async () => {
  const params = new URLSearchParams(location.search);
  const bugs = await fetch('bugs.json')
    .then((response) => (response.ok ? response.json() : {}))
    .catch(() => ({}));

  const canvas = document.getElementById('screen');
  const context = canvas.getContext('2d');
  const overlay = document.getElementById('overlay');
  const overlayButton = document.getElementById('overlay-button');

  // social mode: from the URL, or from the jurisdiction once authenticated
  let social = params.get('social') === 'true';
  const sessionID = params.get('sessionID');
  const rgs = `https://${bugs.ignoreRgsUrl ? 'rgs.example.com' : params.get('rgs_url')}`;
  const MICRO = 1_000_000;
  const SYMBOL = { USD: '$', EUR: '€', GBP: '£', JPY: '¥' };
  const COLORS = { A: '#f2c94c', K: '#6fcf97', Q: '#56ccf2', J: '#bb6bd9', W: '#eb5757' };

  const state = {
    currency: params.get('currency') || 'USD',
    balance: 0,
    bet: MICRO,
    levels: [],
    jurisdiction: {},
    board: null,
    win: 0,
    message: '',
    busy: false,
    started: performance.now(),
    spent: 0,
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  const money = (amount, digits = bugs.trailingZero ? 3 : 2) => {
    const value = (amount / MICRO).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
    const symbol = SYMBOL[state.currency];
    return symbol ? `${symbol}${value}` : `${state.currency} ${value}`;
  };
  const post = async (path, body) => {
    try {
      const response = await fetch(rgs + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionID, ...body }),
      });
      return { ok: response.ok, data: await response.json().catch(() => ({})) };
    } catch {
      return { ok: false, data: { error: 'network' } };
    }
  };

  // ---------------------------------------------------------------- drawing

  function resize() {
    canvas.width = innerWidth * devicePixelRatio;
    canvas.height = innerHeight * devicePixelRatio;
    draw();
  }

  function text(value, x, y, size, color = '#e8ecf2') {
    context.fillStyle = color;
    context.font = `600 ${size}px system-ui, sans-serif`;
    context.fillText(value, x, y);
  }

  /** Drawn a letter at a time, the way Pixi draws text with letter spacing. */
  function spaced(value, x, y, size) {
    context.font = `800 ${size}px system-ui, sans-serif`;
    context.fillStyle = '#f2c94c';
    for (const letter of value) {
      context.fillText(letter, x, y);
      x += context.measureText(letter).width + size * 0.15;
    }
  }

  function draw() {
    const width = canvas.width;
    const height = canvas.height;
    const unit = Math.min(width, height) / 24;
    context.clearRect(0, 0, width, height);
    context.textAlign = 'left';
    spaced('FIXTURE SLOT', unit, unit * 2, unit * 1.2);

    const reels = state.board ?? Array.from({ length: 5 }, () => Array.from({ length: 3 }, () => null));
    const cell = Math.min((width - unit * 4) / reels.length, (height - unit * 9) / 3);
    const left = (width - cell * reels.length) / 2;
    const top = unit * 3.5;
    context.fillStyle = '#1a2029';
    context.beginPath();
    context.roundRect(left - unit * 0.4, top - unit * 0.4, cell * reels.length + unit * 0.8, cell * 3 + unit * 0.8, unit * 0.6);
    context.fill();
    reels.forEach((reel, x) =>
      reel.forEach((symbol, y) => {
        const cx = left + x * cell + cell / 2;
        const cy = top + y * cell + cell / 2;
        context.fillStyle = symbol ? COLORS[symbol.name] ?? '#5b6b80' : '#232b36';
        context.beginPath();
        context.arc(cx, cy, cell * 0.38, 0, Math.PI * 2);
        context.fill();
        if (!symbol) return;
        context.textAlign = 'center';
        text(symbol.name, cx, cy + cell * 0.13, cell * 0.36, '#10141a');
        context.textAlign = 'left';
      }),
    );

    if (!state.ready) return;
    const bottom = height - unit * 1.5;
    text(`BALANCE ${money(state.balance)}`, unit, bottom, unit * 0.8);
    text(`${social ? 'PLAY' : 'BET'} ${money(state.bet)}`, width / 2 - unit * 3, bottom, unit * 0.8);
    if (state.win) text(`WIN ${money(state.win, bugs.winZero ? 3 : undefined)}`, width - unit * 8, bottom, unit * 0.8, '#f2c94c');
    if (social && bugs.socialWords) text('BUY BONUS', width - unit * 8, unit * 2, unit * 0.8);
    if (state.message) text(state.message, unit, bottom - unit * 1.4, unit * 0.7, '#9fb3c8');

    const flags = [];
    if (state.jurisdiction.displayRTP) flags.push('RTP 96.20%');
    if (state.jurisdiction.displaySessionTimer) {
      const seconds = Math.floor((performance.now() - state.started) / 1000);
      flags.push(`${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`);
    }
    if (state.jurisdiction.displayNetPosition) flags.push(`NET ${money(state.balanceAtStart - state.balance)}`);
    if (flags.length) text(flags.join('   '), width - unit * 12, unit * 2, unit * 0.6, '#9fb3c8');
  }

  // ---------------------------------------------------------------- rounds

  /** Plays a round's events. In a live round with free spins, progress is saved with /bet/event. */
  async function present(round, { from = 0, save = true } = {}) {
    state.win = 0;
    const events = round.state ?? [];
    for (let index = from; index < events.length; index++) {
      const event = events[index];
      if (event.type === 'reveal') state.board = event.board;
      if (event.type === 'freeSpinTrigger') state.message = social ? 'FREE SPINS' : 'FREE SPINS WON';
      if (event.type === 'finalWin') state.win = Math.round(state.bet * (event.amount / 100));
      draw();
      if (save && events.length > 3) await post('/bet/event', { event: bugs.numericEvent ? index : String(index) });
      await sleep(event.type === 'reveal' ? 350 : 150);
    }
  }

  async function spin() {
    if (state.busy && !bugs.doubleBet) return;
    if (state.balance < state.bet) {
      state.message = 'Balance too low';
      draw();
      return;
    }
    state.busy = true;
    state.message = '';
    const started = performance.now();
    const amount = bugs.hardcodedBet ? MICRO : state.bet;
    const { ok, data } = await post('/wallet/play', { amount, currency: state.currency, mode: 'BASE' });
    if (!ok) {
      state.message = `Something went wrong (${data.error ?? 'error'}). Try again.`;
      state.busy = false;
      draw();
      return;
    }
    state.balance = data.balance.amount;
    await present(data.round);
    if (data.round.active && !bugs.noEndRound) {
      const end = await post('/wallet/end-round', {});
      if (end.ok) state.balance = end.data.balance.amount;
    }
    const minimum = (state.jurisdiction.minimumRoundDuration || 0) * 1000;
    if (!bugs.ignoreMinimumDuration) await sleep(minimum - (performance.now() - started));
    state.busy = false;
    draw();
  }

  async function resume(round) {
    state.busy = true;
    state.bet = round.amount;
    state.message = 'Picking up where you left off';
    await present(round, { from: round.event === undefined ? 0 : Number(round.event) + 1 });
    if (!bugs.noEndRound) {
      const end = await post('/wallet/end-round', {});
      if (end.ok) state.balance = end.data.balance.amount;
    }
    state.message = '';
    state.busy = false;
    draw();
  }

  async function replay() {
    const path = ['game', 'version', 'mode', 'event'].map((key) => encodeURIComponent(params.get(key))).join('/');
    const response = await fetch(`${rgs}/bet/replay/${path}`);
    if (!response.ok) {
      state.message = 'This replay is not available';
      draw();
      return;
    }
    const data = await response.json();
    if (bugs.throwOnReplay) throw new Error('replay broke');
    state.ready = true;
    state.bet = Number(params.get('amount')) || MICRO;
    const cost = data.costMultiplier ?? 1;
    const lines = social
      ? [`PLAY ${money(state.bet)} x${cost}`, `WIN ${data.payoutMultiplier.toFixed(2)}x`]
      : [`BET ${money(state.bet)}`, `COST ${cost}x = ${money(state.bet * cost)}`, `PAYOUT ${data.payoutMultiplier.toFixed(2)}x`];
    state.message = lines.join('   ');
    draw();
    overlayButton.textContent = 'Play replay';
    overlay.hidden = false;
    await new Promise((resolve) => {
      overlayButton.onclick = resolve;
      addEventListener('keydown', (event) => event.code === 'Space' && resolve(), { once: true });
    });
    overlay.hidden = true;
    await present({ state: data.state }, { save: false });
    state.message = 'Replay finished';
    draw();
  }

  // ---------------------------------------------------------------- start

  addEventListener('resize', resize);
  resize();
  if (bugs.externalRequest) new Image().src = 'https://example.com/pixel.png';
  if (bugs.rootPath) fetch('/settings.json').catch(() => {});
  if (bugs.consoleError) console.error('fixture: something broke');

  if (params.get('replay') === 'true') {
    await replay();
    return;
  }

  const auth = await post('/wallet/authenticate', { language: params.get('lang') || 'en' });
  if (!auth.ok) {
    state.message = auth.data.error === 'network' ? "Can't reach the game server. Check your connection." : 'Your session has expired. Reload the game.';
    draw();
    return;
  }
  state.balance = auth.data.balance.amount;
  state.balanceAtStart = state.balance;
  state.levels = auth.data.config.betLevels;
  state.bet = auth.data.config.defaultBetLevel;
  state.jurisdiction = auth.data.config.jurisdiction ?? {};
  social ||= Boolean(state.jurisdiction.socialCasino);
  state.ready = true;
  draw();
  setInterval(draw, 1000);

  const intro = new Promise((resolve) => {
    overlay.hidden = false;
    overlayButton.onclick = resolve;
  }).then(() => {
    overlay.hidden = true;
  });

  addEventListener('keydown', (event) => {
    if (event.code !== 'Space' || event.repeat) return;
    event.preventDefault();
    if (!overlay.hidden) return overlayButton.click();
    if (state.jurisdiction.disabledSpacebar && !bugs.ignoreSpacebarFlag) return;
    spin();
  });

  await intro;
  if (auth.data.round?.active) await resume(auth.data.round);
})();
