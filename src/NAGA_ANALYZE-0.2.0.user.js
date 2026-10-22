// ==UserScript==
// @name         NAGA_ANALYZE (fixed for modern Mahjong Soul)
// @namespace    mjg
// @icon         https://cdn.myanimelist.net/images/characters/12/75583.jpg
// @version      0.2.0
// @description  Capture a Mahjong Soul replay via WebSocket hook, decode the protobuf in-browser, and download a tenhou json6 (.json) file for mortal/akochan scoring. Press "s" while a 4-player replay is loaded.
// @author       fixed build (original: NAGA_ANALYZE 0.1.1; modern capture adapted from honvl/Majsoul-to-NAGA / AsaChiri/majsoul-naga)
// @license      MIT
// @match        https://game.maj-soul.com/1/*
// @match        https://mahjongsoul.game.yo-star.com/*
// @match        https://game.mahjongsoul.com/*
// @match        https://majsoul.union-game.com/0/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * Why this rewrite exists
 * -----------------------
 * The original NAGA_ANALYZE (0.1.1) called GameMgr.Inst / net.MessageWrapper /
 * app.NetAgent / cfg / uiscript — globals that modern Mahjong Soul no longer
 * exposes. Those calls now fail silently, so pressing "s" did nothing.
 *
 * This version hooks window.WebSocket at page load, captures the raw
 * `fetchGameRecord` replay response frame, decodes the Mahjong Soul protobuf
 * with a tiny generic wire-decoder (keyed by field numbers), converts it to the
 * tenhou json6 format, and downloads it as a .json file you can feed to mortal.
 * It also prints a tenhou.net/5 viewer link so you can sanity-check the result.
 *
 * Usage: install in Tampermonkey/Violentmonkey, open a 4-player replay, wait
 * for it to load, then press "s". A file download starts automatically.
 */
(function () {
  "use strict";

  // ---- config ------------------------------------------------------------
  const TRIGGER_KEY = "s";

  // ---- logging -----------------------------------------------------------
  const TAG = "[naga-analyze]";
  const log = (...a) => console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);
  const logError = (...a) => console.error(TAG, ...a);

  // ---- generic protobuf wire decoder -------------------------------------
  // decode(Uint8Array) -> { fieldNumber: [values] }, value = number (varint) or Uint8Array (len-delimited)
  const TWO63 = 1n << 63n,
    TWO64 = 1n << 64n;
  const toSigned = (b) => (b >= TWO63 ? b - TWO64 : b);
  const num = (b) => Number(toSigned(b));
  function readVarint(buf, p) {
    let shift = 0n,
      result = 0n;
    for (;;) {
      const b = buf[p.i++];
      result |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return result;
      shift += 7n;
    }
  }
  function decode(buf) {
    const out = {},
      p = { i: 0 };
    while (p.i < buf.length) {
      const tag = Number(readVarint(buf, p)),
        fn = tag >> 3,
        wt = tag & 7;
      let val;
      if (wt === 0) val = readVarint(buf, p);
      else if (wt === 2) {
        const len = Number(readVarint(buf, p));
        val = buf.subarray(p.i, p.i + len);
        p.i += len;
      } else if (wt === 1) {
        p.i += 8;
        val = 0n;
      } else if (wt === 5) {
        p.i += 4;
        val = 0n;
      } else break;
      (out[fn] = out[fn] || []).push(val);
    }
    return out;
  }
  const TD = new TextDecoder();
  const one = (m, n) => (m[n] ? m[n][0] : undefined);
  const all = (m, n) => m[n] || [];
  const pint = (m, n) => {
    const v = one(m, n);
    return v === undefined ? 0 : num(v);
  };
  const pbool = (m, n) => {
    const v = one(m, n);
    return v !== undefined && v !== 0n;
  };
  const pstr = (m, n) => {
    const v = one(m, n);
    return v instanceof Uint8Array ? TD.decode(v) : "";
  };
  const pstrs = (m, n) =>
    all(m, n)
      .filter((v) => v instanceof Uint8Array)
      .map((v) => TD.decode(v));
  const psub = (m, n) => {
    const v = one(m, n);
    return v instanceof Uint8Array ? decode(v) : null;
  };
  const psubs = (m, n) =>
    all(m, n)
      .filter((v) => v instanceof Uint8Array)
      .map((v) => decode(v));
  function pints(m, n) {
    const out = [];
    for (const v of all(m, n)) {
      if (v instanceof Uint8Array) {
        const p = { i: 0 };
        while (p.i < v.length) out.push(num(readVarint(v, p)));
      } else out.push(num(v));
    }
    return out;
  }

  // ---- tiles -------------------------------------------------------------
  const TSUMOGIRI = 60;
  const TYPE = { m: 0, p: 1, s: 2, z: 3 };
  function tile(text) {
    return { num: parseInt(text[0], 10), t: TYPE[text[1].toLowerCase()] };
  }
  function tEnc(x) {
    return x.num !== 0 ? 10 * (x.t + 1) + x.num : 50 + (x.t + 1);
  }
  function tDeaka(x) {
    return x.num === 0 && x.t !== TYPE.z ? { num: 5, t: x.t } : x;
  }
  const tEq = (a, b) => a.num === b.num && a.t === b.t;

  // ---- meld / discard encoders (return int or string) --------------------
  function encDiscard(s) {
    let v = s.tsumogiri ? TSUMOGIRI : tEnc(s.tile);
    return s.riichi ? "r" + v : v;
  }
  function encChi(s) {
    return "c" + tEnc(s.called) + tEnc(s.a) + tEnc(s.b);
  }
  function encPon(s) {
    const t = [String(tEnc(s.a)), String(tEnc(s.b))];
    t.splice(s.fr, 0, "p" + tEnc(s.called));
    return t.join("");
  }
  function encDaiminkan(s) {
    let pos = s.fr === 2 ? 3 : s.fr;
    const t = [String(tEnc(s.a)), String(tEnc(s.b)), String(tEnc(s.c))];
    t.splice(pos, 0, "m" + tEnc(s.called));
    return t.join("");
  }
  function encAnkan(s) {
    const t = tEnc(s.tile);
    if (s.tile.num === 5 && s.tile.t !== TYPE.z) {
      return "" + tEnc({ num: 0, t: s.tile.t }) + t + t + "a" + t;
    }
    return "" + t + t + t + "a" + t;
  }
  function encKakan(s) {
    const t = [String(tEnc(s.a)), String(tEnc(s.b)), String(tEnc(s.c))];
    t.splice(s.fr, 0, "k" + tEnc(s.added));
    return t.join("");
  }
  const encZero = () => 0;
  function encStream(item) {
    if (item.kind === "tile") return tEnc(item);
    return item.enc(item);
  }

  // ---- scoring constants & yaku -----------------------------------------
  const DAISANGEN = 37,
    DAISUUSHI = 50;
  const TSUMO_OYA_PAYS_KO = 16000,
    TSUMO_KO_PAYS_OYA = 16000,
    TSUMO_KO_PAYS_KO = 8000,
    RON_OYA = 48000,
    RON_KO = 32000;
  const WINDS = ["東", "南", "西", "北"];
  const LIMIT = {
    mangan: "満貫",
    haneman: "跳満",
    baiman: "倍満",
    sanbaiman: "三倍満",
    yakuman: "役満",
    kazoe: "数え役満",
    kiriage: "切り上げ満貫",
  };
  const ABORT = { 1: "九種九牌", 2: "四風連打", 3: "四家立直", 4: "四開槓", 5: "三家和" };
  const YAKU_NAMES = {
    1: "門前清自摸和",
    2: "立直",
    3: "槍槓",
    4: "嶺上開花",
    5: "海底摸月",
    6: "河底撈魚",
    7: "役牌 白",
    8: "役牌 發",
    9: "役牌 中",
    10: "役牌:自風牌",
    11: "役牌:場風牌",
    12: "断幺九",
    13: "一盃口",
    14: "平和",
    15: "混全帯幺九",
    16: "一気通貫",
    17: "三色同順",
    18: "ダブル立直",
    19: "三色同刻",
    20: "三槓子",
    21: "対々和",
    22: "三暗刻",
    23: "小三元",
    24: "混老頭",
    25: "七対子",
    26: "純全帯幺九",
    27: "混一色",
    28: "二盃口",
    29: "清一色",
    30: "一発",
    31: "ドラ",
    32: "赤ドラ",
    33: "裏ドラ",
    34: "抜きドラ",
    35: "天和",
    36: "地和",
    37: "大三元",
    38: "四暗刻",
    39: "字一色",
    40: "緑一色",
    41: "清老頭",
    42: "国士無双",
    43: "小四喜",
    44: "四槓子",
    45: "九蓮宝燈",
    46: "八連荘",
    47: "純正九蓮宝燈",
    48: "四暗刻単騎",
    49: "国士無双十三面待ち",
    50: "大四喜",
    51: "燕返し",
    52: "槓振り",
    53: "十二落抬",
    54: "五門斉",
    55: "三連刻",
    56: "一色三順",
    57: "一筒摸月",
    58: "九筒撈魚",
    59: "人和",
    60: "大車輪",
    61: "大竹林",
    62: "大数隣",
    63: "石の上にも三年",
    64: "大七星",
    1000: "根",
    1001: "嶺上開花",
    1002: "嶺上放銃",
    1003: "無番和",
    1004: "槍槓",
    1005: "対々和",
    1006: "清一色",
    1007: "七対子",
    1008: "帯幺九",
    1009: "金勾釣",
    1010: "清対",
    1011: "将対",
    1012: "龍七対",
    1013: "清七対",
    1014: "清金勾釣",
    1015: "清龍七対",
    1016: "十八羅漢",
    1017: "清十八羅漢",
    1018: "天和",
    1019: "地和",
    1020: "清幺九",
    1021: "海底摸月",
  };

  function yakuName(id, rnd, seat) {
    if (id === 10) return "自風 " + WINDS[(((seat - rnd.kyoku) % 4) + 4) % 4];
    if (id === 11) return "場風 " + WINDS[Math.floor(rnd.kyoku / 4)];
    if (id === 18) return "両立直";
    return YAKU_NAMES[id] || "yaku" + id;
  }
  function pointLevel(pt) {
    let j;
    if (pt.ron === 0) j = pt.oya ? (pt.tsumo * 3) / 1.5 : pt.tsumo * 2 + pt.tsumo_oya;
    else j = pt.oya ? pt.ron / 1.5 : pt.ron;
    if (j >= 32000) return "yakuman";
    if (j >= 24000) return "sanbaiman";
    if (j >= 16000) return "baiman";
    if (j >= 12000) return "haneman";
    if (j >= 8000) return "mangan";
    return null;
  }
  function scoreString(w) {
    let pts;
    if (w.tsumo) pts = w.oya ? `${w.point.tsumo}点∀` : `${w.point.tsumo}-${w.point.tsumo_oya}点`;
    else pts = `${w.point.ron}点`;
    const lv = pointLevel(w.point);
    if (lv === null) return `${w.fu}符${w.han}飜${pts}`;
    let prefix;
    if (lv === "yakuman") prefix = w.han >= 13 ? LIMIT.kazoe : LIMIT.yakuman;
    else if (lv === "mangan") {
      const tm = w.han >= 5 || (w.han >= 4 && w.fu >= 40) || (w.han >= 3 && w.fu >= 70);
      prefix = tm ? LIMIT.mangan : LIMIT.kiriage;
    } else prefix = LIMIT[lv];
    return prefix + pts;
  }

  // ---- game parser ------------------------------------------------------
  const rel = (seat, feeder) => (seat - feeder + 3) % 4;
  function GameParser() {
    this.kyokus = [];
    this.cur = null;
  }
  GameParser.prototype.feed = function (name, m) {
    switch (name) {
      case "RecordNewRound":
        return this._newRound(m);
      case "RecordDealTile":
        return this._deal(m);
      case "RecordDiscardTile":
        return this._discard(m);
      case "RecordChiPengGang":
        return this._call(m);
      case "RecordAnGangAddGang":
        return this._kan(m);
      case "RecordLiuJu":
        return this._liuju(m);
      case "RecordNoTile":
        return this._notile(m);
      case "RecordHule":
        return this._hule(m);
    }
  };
  GameParser.prototype._acceptRiichi = function () {
    if (this._pending) {
      this._pending = false;
      this.nriichi++;
    }
  };
  GameParser.prototype._dora = function (doras) {
    if (doras.length > this.cur.doras.length) this.cur.doras = doras.map(tile);
  };
  GameParser.prototype._countPao = function (t, owner, feeder) {
    if (t.t !== TYPE.z) return;
    if (t.num >= 1 && t.num <= 4) {
      if (++this.nowinds[owner] === 4) this.paowind = feeder;
    } else if (t.num >= 5 && t.num <= 7) {
      if (++this.nodrags[owner] === 3) this.paodrag = feeder;
    }
  };
  GameParser.prototype._newRound = function (m) {
    const scores = pints(m, 5);
    if (scores.length !== 4) throw new Error("only 4-player games are supported (got " + scores.length + ")");
    const dora = pstr(m, 4);
    const doras = dora ? [tile(dora)] : pstrs(m, 16).map(tile);
    const haipais = [7, 8, 9, 10].map((n) => pstrs(m, n).map(tile));
    this.cur = {
      rnd: { kyoku: 4 * pint(m, 1) + pint(m, 2), honba: pint(m, 3), riichi: pint(m, 6) },
      init: scores,
      doras,
      draws: [[], [], [], []],
      discards: [[], [], [], []],
      haipais,
      result: null,
    };
    this.dealer = pint(m, 2);
    this.popped = this.cur.haipais[this.dealer].pop();
    this.cur.draws[this.dealer].push({ kind: "tile", ...this.popped });
    this.ldseat = -1;
    this.nriichi = 0;
    this.nkan = 0;
    this._pending = false;
    this.nowinds = [0, 0, 0, 0];
    this.nodrags = [0, 0, 0, 0];
    this.paowind = -1;
    this.paodrag = -1;
  };
  GameParser.prototype._deal = function (m) {
    this._acceptRiichi();
    this._dora(pstrs(m, 6));
    this.cur.draws[pint(m, 1)].push({ kind: "tile", ...tile(pstr(m, 2)) });
  };
  GameParser.prototype._discard = function (m) {
    const seat = pint(m, 1),
      t = tile(pstr(m, 2));
    let tg = pbool(m, 5);
    if (seat === this.dealer && this.cur.discards[seat].length === 0 && this.popped && tEq(t, this.popped))
      tg = true;
    const riichi = pbool(m, 3);
    this.cur.discards[seat].push({ enc: encDiscard, tile: t, tsumogiri: tg, riichi });
    if (riichi) this._pending = true;
    this.ldseat = seat;
    this._dora(pstrs(m, 8));
  };
  GameParser.prototype._call = function (m) {
    this._acceptRiichi();
    const seat = pint(m, 1),
      type = pint(m, 2),
      tiles = pstrs(m, 3).map(tile);
    if (type === 0) this.cur.draws[seat].push({ enc: encChi, a: tiles[0], b: tiles[1], called: tiles[2] });
    else if (type === 1) {
      const fr = rel(seat, this.ldseat);
      this._countPao(tiles[0], seat, this.ldseat);
      this.cur.draws[seat].push({ enc: encPon, a: tiles[0], b: tiles[1], called: tiles[2], fr });
    } else if (type === 2) {
      const fr = rel(seat, this.ldseat);
      this._countPao(tiles[0], seat, this.ldseat);
      this.cur.draws[seat].push({
        enc: encDaiminkan,
        a: tiles[0],
        b: tiles[1],
        c: tiles[2],
        called: tiles[3],
        fr,
      });
      this.cur.discards[seat].push({ enc: encZero });
      this.nkan++;
    } else throw new Error("bad RecordChiPengGang.type=" + type);
  };
  GameParser.prototype._kan = function (m) {
    const seat = pint(m, 1),
      type = pint(m, 2),
      t = tile(pstr(m, 3));
    this.ldseat = seat;
    if (type === 3) {
      this._countPao(t, seat, -1);
      this.cur.discards[seat].push({ enc: encAnkan, tile: tDeaka(t) });
      this.nkan++;
    } else if (type === 2) {
      for (const s of this.cur.draws[seat]) {
        if (s.enc === encPon && tEq(tDeaka(s.called), tDeaka(t))) {
          this.cur.discards[seat].push({ enc: encKakan, a: s.a, b: s.b, c: s.called, added: t, fr: s.fr });
          this.nkan++;
          break;
        }
      }
    } else throw new Error("bad RecordAnGangAddGang.type=" + type);
  };
  GameParser.prototype._finish = function () {
    this.kyokus.push(this.cur);
    this.cur = null;
  };
  GameParser.prototype._liuju = function (m) {
    this._acceptRiichi();
    const type = pint(m, 1);
    let r;
    if (type === 1) r = 1;
    else if (type === 2) r = 2;
    else if (this.nriichi === 4) r = 3;
    else if (this.nkan === 4) r = 4;
    else throw new Error("bad RecordLiuJu.type=" + type);
    this.cur.result = { kind: "abort", code: r };
    this._finish();
  };
  GameParser.prototype._notile = function (m) {
    const delta = [0, 0, 0, 0];
    for (const s of psubs(m, 3)) {
      const d = pints(s, 3);
      d.forEach((x, i) => (delta[i] += x));
    }
    this.cur.result = { kind: "ryuukyoku", delta, nagashi: pbool(m, 1) };
    this._finish();
  };
  GameParser.prototype._hule = function (m) {
    const wins = [];
    let ura = [];
    for (const h of psubs(m, 1)) {
      const li = pstrs(h, 9);
      if (li.length > ura.length) ura = li.map(tile);
      wins.push(this._parseHule(h));
    }
    this.cur.result = { kind: "agari", wins, ura, rnd: this.cur.rnd };
    this._finish();
  };
  GameParser.prototype._parseHule = function (h) {
    let rp, hb;
    if (this.nriichi !== -1) {
      rp = 1000 * (this.nriichi + this.cur.rnd.riichi);
      hb = 100 * this.cur.rnd.honba;
    } else {
      rp = 0;
      hb = 0;
    }
    const seat = pint(h, 4),
      zimo = pbool(h, 5),
      qinjia = pbool(h, 6),
      yiman = pbool(h, 10);
    const count = pint(h, 11),
      fu = pint(h, 13);
    const rong = pint(h, 15),
      zqin = pint(h, 16),
      zxian = pint(h, 17);
    const fans = psubs(h, 12).map((f) => ({ id: pint(f, 3), val: pint(f, 2) }));

    let pao = false,
      liable = -1,
      liableFor = 0;
    if (yiman)
      for (const f of fans) {
        if (f.id === DAISUUSHI && this.paowind !== -1) {
          pao = true;
          liable = this.paowind;
          liableFor = f.val;
          break;
        }
        if (f.id === DAISANGEN && this.paodrag !== -1) {
          pao = true;
          liable = this.paodrag;
          liableFor = f.val;
          break;
        }
      }

    let delta, point;
    if (zimo) {
      delta = [-hb - zxian, -hb - zxian, -hb - zxian, -hb - zxian];
      if (seat === this.dealer) {
        delta[seat] = rp + 3 * (hb + zxian);
        point = { tsumo: zxian, tsumo_oya: 0, ron: 0, oya: true };
      } else {
        delta[seat] = rp + hb + zqin + 2 * (hb + zxian);
        delta[this.dealer] = -hb - zqin;
        point = { tsumo: zxian, tsumo_oya: zqin, ron: 0, oya: false };
      }
    } else {
      delta = [0, 0, 0, 0];
      delta[seat] = rp + 3 * hb + rong;
      delta[this.ldseat] = -3 * hb - rong;
      point = { ron: rong, tsumo: 0, tsumo_oya: 0, oya: qinjia };
      this.nriichi = -1;
    }
    if (pao) {
      if (!zimo) {
        const pay = 3 * hb + Math.floor((liableFor * (qinjia ? RON_OYA : RON_KO)) / 2);
        delta[liable] -= pay;
        delta[this.ldseat] += pay;
      } else if (qinjia) {
        delta[liable] -= 2 * hb + liableFor * 2 * TSUMO_OYA_PAYS_KO;
        for (let i = 0; i < 4; i++)
          if (i !== liable && i !== seat) delta[i] += hb + liableFor * TSUMO_OYA_PAYS_KO;
      } else {
        delta[liable] -= 2 * hb + liableFor * (TSUMO_KO_PAYS_OYA + TSUMO_KO_PAYS_KO);
        for (let i = 0; i < 4; i++)
          if (i !== liable && i !== seat)
            delta[i] += hb + liableFor * (i === this.dealer ? TSUMO_KO_PAYS_OYA : TSUMO_KO_PAYS_KO);
      }
    }
    return {
      seat,
      from: zimo ? seat : this.ldseat,
      pao: pao ? liable : seat,
      han: count,
      fu,
      yaku: fans,
      oya: qinjia,
      tsumo: zimo,
      yakuman: yiman,
      point,
      delta,
    };
  };

  // ---- result + round encoders ------------------------------------------
  function dumpResult(r) {
    if (r.kind === "abort") return [ABORT[r.code]];
    if (r.kind === "ryuukyoku") return [r.nagashi ? "流し満貫" : "流局", r.delta];
    const out = ["和了"];
    for (const w of r.wins) {
      out.push(w.delta);
      const detail = [w.seat, w.from, w.pao, scoreString(w)];
      for (const y of w.yaku)
        detail.push(`${yakuName(y.id, r.rnd, w.seat)}(${w.yakuman ? "役満" : y.val + "飜"})`);
      out.push(detail);
    }
    return out;
  }
  function dumpKyoku(k) {
    const entry = [
      [k.rnd.kyoku, k.rnd.honba, k.rnd.riichi],
      k.init,
      k.doras.map(tEnc),
      k.result && k.result.kind === "agari" ? k.result.ura.map(tEnc) : [],
    ];
    for (let seat = 0; seat < 4; seat++) {
      entry.push(k.haipais[seat].map(tEnc));
      entry.push(k.draws[seat].map(encStream));
      entry.push(k.discards[seat].map(encStream));
    }
    if (k.result) entry.push(dumpResult(k.result));
    return entry;
  }

  // ---- ResGameRecord -> tenhou json6 -----------------------------------
  function decodeRecord(resBytes) {
    const res = decode(resBytes);
    const err = psub(res, 1);
    if (err && pint(err, 1)) throw new Error("fetch_game_record error " + pint(err, 1));
    const head = psub(res, 3) || {};
    const cfg = psub(head, 5);
    const gmode = cfg ? psub(cfg, 2) : null;
    const mode = gmode ? pint(gmode, 1) : 0;

    const names = ["AI", "AI", "AI", "AI"];
    for (const a of psubs(head, 11)) {
      const seat = pint(a, 2),
        nick = pstr(a, 3);
      if (seat >= 0 && seat < 4 && nick) names[seat] = nick;
    }
    const sc = [0, 0, 0, 0, 0, 0, 0, 0];
    const result = psub(head, 12);
    if (result) {
      for (const p of psubs(result, 1)) {
        const seat = pint(p, 1);
        if (seat >= 0 && seat < 4) {
          sc[2 * seat] = pint(p, 3);
          sc[2 * seat + 1] = pint(p, 2) / 1000;
        }
      }
    }
    return {
      uuid: pstr(head, 1),
      endTime: pint(head, 3),
      data: one(res, 4),
      dataUrl: pstr(res, 5),
      mode,
      names,
      sc,
    };
  }
  function convert(dataBlob, meta) {
    const inner = decode(dataBlob);
    const details = decode(one(inner, 2));
    const version = pint(details, 2);
    let blobs;
    if (version < 210715 && details[1]) blobs = all(details, 1);
    else
      blobs = psubs(details, 3)
        .map((a) => one(a, 3))
        .filter(Boolean);

    const parser = new GameParser();
    for (const blob of blobs) {
      const w = decode(blob);
      const name = pstr(w, 1).replace(/^\.lq\./, "");
      const body = one(w, 2);
      parser.feed(name, body ? decode(body) : {});
    }
    const log = parser.kyokus.map(dumpKyoku);
    // Mahjong Soul always uses 3 red fives (one per suit).
    const disp = (meta.mode === 1 ? "東" : "南") + "喰赤";
    const ts = meta.endTime
      ? new Date(meta.endTime * 1000).toISOString().slice(0, 19).replace("T", " ")
      : "";
    return {
      ver: "2.3",
      ref: meta.uuid,
      ratingc: "PF4",
      rule: { disp: disp, aka53: 1, aka52: 1, aka51: 1 },
      lobby: 0,
      dan: ["", "", "", ""],
      rate: [0, 0, 0, 0],
      sx: ["C", "C", "C", "C"],
      name: meta.names || ["AI", "AI", "AI", "AI"],
      sc: meta.sc || [0, 0, 0, 0, 0, 0, 0, 0],
      title: [disp, ts],
      log,
    };
  }

  // ---- capture via WebSocket hook --------------------------------------
  let captured = null,
    wantIndex = null,
    expecting = false;
  const REQ_MARK = ".lq.Lobby.fetchGameRecord";
  function bytesIncludeAscii(buf, s) {
    outer: for (let i = 0; i + s.length <= buf.length; i++) {
      for (let j = 0; j < s.length; j++) if (buf[i + j] !== s.charCodeAt(j)) continue outer;
      return true;
    }
    return false;
  }
  function frameBytes(data) {
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return null;
  }
  function looksLikeRecord(wrapperBytes) {
    try {
      const resB = one(decode(wrapperBytes), 2);
      if (!resB) return false;
      const res = decode(resB);
      return !!(res[3] && (res[4] || res[5]));
    } catch (_) {
      return false;
    }
  }
  function installWsHook() {
    // With @grant none the script runs in the page world, so window IS the
    // page's window. Guard for managers that wrap it in an isolated world.
    const W = typeof unsafeWindow !== "undefined" && unsafeWindow ? unsafeWindow : window;
    const Orig = W.WebSocket;
    if (!Orig) {
      warn("no WebSocket constructor to hook");
      return;
    }
    W.WebSocket = new Proxy(Orig, {
      construct(target, args) {
        const ws = new target(...args);
        log("WebSocket hooked:", args[0]);
        const origSend = ws.send.bind(ws);
        ws.send = function (data) {
          try {
            const b = frameBytes(data);
            if (
              b &&
              b[0] === 2 &&
              bytesIncludeAscii(b, REQ_MARK) &&
              pstr(decode(b.subarray(3)), 1) === REQ_MARK
            ) {
              wantIndex = b[1] | (b[2] << 8);
              expecting = true;
              captured = null;
              log("fetchGameRecord request seen (idx " + wantIndex + ")");
            }
          } catch (_) {}
          return origSend(data);
        };
        ws.addEventListener("message", (ev) => {
          const handle = (buf) => {
            if (captured || buf[0] !== 3) return;
            const wrapper = buf.subarray(3);
            const idxMatch = wantIndex !== null && (buf[1] | (buf[2] << 8)) === wantIndex;
            if (idxMatch || (expecting && looksLikeRecord(wrapper))) {
              captured = buf.slice(3);
              expecting = false;
              log("captured record frame (" + buf.length + " bytes) — press '" + TRIGGER_KEY + "'");
            }
          };
          if (ev.data instanceof ArrayBuffer) handle(new Uint8Array(ev.data));
          else if (ev.data instanceof Blob) ev.data.arrayBuffer().then((ab) => handle(new Uint8Array(ab)));
        });
        return ws;
      },
    });
    log("WebSocket hook installed");
  }

  function capturedResGameRecord() {
    if (!captured) return null;
    const w = decode(captured);
    return one(w, 2) || null;
  }

  // ---- UI ---------------------------------------------------------------
  function toast(msg, ms = 5000) {
    let el = document.getElementById("__na_toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "__na_toast";
      el.style.cssText =
        "position:fixed;z-index:99999;left:50%;bottom:28px;transform:translateX(-50%);background:#222;color:#fff;padding:10px 16px;border-radius:8px;font:14px/1.4 sans-serif;max-width:80vw;box-shadow:0 2px 10px rgba(0,0,0,.4)";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity = "1";
    clearTimeout(el._t);
    el._t = setTimeout(() => (el.style.opacity = "0"), ms);
  }
  function downloadFile(filename, text) {
    const element = document.createElement("a");
    element.setAttribute("href", "data:text/plain;charset=utf-8," + encodeURIComponent(text));
    element.setAttribute("download", filename);
    element.style.display = "none";
    document.body.appendChild(element);
    element.click();
    document.body.removeChild(element);
  }
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      return false;
    }
  }
  function viewerLink(tenhou, which) {
    const base = which === "6" ? "https://tenhou.net/6/" : "https://tenhou.net/5/";
    return base + "#json=" + encodeURIComponent(JSON.stringify(tenhou));
  }

  let running = false;
  async function run() {
    if (running) return;
    running = true;
    try {
      const resBytes = capturedResGameRecord();
      if (!resBytes) {
        toast("No replay captured yet — open (or reload) a 4-player replay, then press '" + TRIGGER_KEY + "'.");
        return;
      }
      toast("Converting…");
      const rec = decodeRecord(resBytes);
      let blob = rec.data;
      const tenhou = convert(blob, rec);

      log("decoded " + tenhou.log.length + " rounds; ref=" + tenhou.ref + "; mode=" + rec.mode);
      log("full json6 object:", tenhou);
      log("preview at:", viewerLink(tenhou, "5"));

      // filename: date + rule display
      const datePart = tenhou.title[1] ? tenhou.title[1].slice(0, 10) : new Date().toISOString().slice(0, 10);
      const fileSafe = (tenhou.title[0] || "paipu").replace(/[ \/\\:*?"<>|]/g, "_");
      const filename = `${datePart}_${fileSafe}.json`;

      const json = JSON.stringify(tenhou, null, 2);
      downloadFile(filename, json);

      const link5 = viewerLink(tenhou, "5");
      const copied = await copyText(link5);
      toast(
        `Downloaded ${filename} (${tenhou.log.length} 局). 预览链接${copied ? "已复制" : "未复制，见控制台"}：tenhou.net/5`,
        8000,
      );
      if (!copied) log("tenhou.net/5 viewer link:", link5);
    } catch (e) {
      toast("Error: " + e.message, 8000);
      logError(e);
    } finally {
      running = false;
    }
  }

  installWsHook();
  const isTyping = (el) =>
    !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName || ""));
  document.addEventListener("keydown", (e) => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
    if (e.key === TRIGGER_KEY || e.key === TRIGGER_KEY.toUpperCase()) run();
  });
  log("loaded; open a 4-player replay and press '" + TRIGGER_KEY + "'.");
})();
// vim: ts=4  et
