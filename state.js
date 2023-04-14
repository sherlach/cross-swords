'use strict';

const child_process = require('child_process');
const fs = require('fs');
const process = require('process');
const puzjs = require('puzjs');
const yargs = require('yargs/yargs')

const { hideBin } = require('yargs/helpers')
const argv = yargs(hideBin(process.argv)).argv


const CASUAL_GAME_TIME = 15 * 60 * 1000;
const COMP_GAME_TIME = 10 * 60 * 1000;
const GUESS_TIME = 10 * 1000;
const HINT_TIME = 30 * 1000;
const HINT_CAP = 3;
const SIDES = [
  ['red', 0, -1],
  ['blue', -1, 0],
  ['yellow', 0, 0],
  ['purple', -1, -1],
];
const GAMES = 10;
const URL_PREFIX = "http://lachness.monster:9001/";


function rand(list) {
  return list[parseInt(Math.random() * list.length)];
}

const DICT = {};
for (const line of fs.readFileSync(__dirname + '/dict', 'utf8')
    .trim().split('\n')) {
  let [actual, text] = line.split('\t');
  actual = actual.toUpperCase();
  DICT[actual] = DICT[actual] || [];
  DICT[actual].push(text);
}

async function createGame(sides, puzzle, tourney_mode = null) {
  const grid = puzzle.grid;

  const game = {
    id: null,
    urls: {},
    names: {},
    cells: grid.map((row, y) => Array.from(row).map((cell, x) => {
      if (cell == '.') return {
        status: 'wall',
        visible: {},
      };
      const ret = {
        status: 'blank',
        visible: {},
        guess: {},
        timeout: {},
        clues: [],
      };
      if (cell != '#') ret.actual = cell;
      return ret;
    })),
    clues: [],
    log: [],
    hints: {},
    score: {},
    total: 0,
    phase: tourney_mode ? 'locked' : 'created',
    time: tourney_mode ? COMP_GAME_TIME : CASUAL_GAME_TIME,
  };

  let index = 1;
  game.cells.forEach((row, y) => {
    row.forEach((cell, x) => {
      if (cell.status == 'wall') return;
      ++game.total;
      //const across = !row[x - 1] || game.cells[y][x - 1].status == 'wall';
      //const down = !game.cells[y - 1] || game.cells[y - 1][x].status == 'wall';
      const across = (!row[x - 1] || game.cells[y][x - 1].status == 'wall') && row[x + 1] && game.cells[y][x + 1].status != 'wall';
      const down = (!game.cells[y - 1] || game.cells[y - 1][x].status == 'wall') && game.cells[y + 1] && game.cells[y + 1][x].status != 'wall';
      const newClue = dir => ({
        status: 'open',
        dir,
        index,
        cells: [],
        walls: [],
        visible: {},
      });
      if (across) {
	      //console.log(y, x);
        const clue = newClue('across');
        if (x > 0) clue.walls.push([y, x - 1]);
        for (let xx = x;;) {
          game.cells[y][xx].clues.push(game.clues.length);
          clue.cells.push([y, xx]);
          if (!row[++xx]) break;
          else if (game.cells[y][xx].status == 'wall') {
            clue.walls.push([y, xx]);
            break;
          }
        }
	      //console.log(clue);
        game.clues.push(clue);
      }
      if (down) {
        const clue = newClue('down');
        if (y > 0) clue.walls.push([y - 1, x]);
        for (let yy = y;;) {
          game.cells[yy][x].clues.push(game.clues.length);
          clue.cells.push([yy, x]);
          if (!game.cells[++yy]) break;
          else if (game.cells[yy][x].status == 'wall') {
            clue.walls.push([yy, x]);
            break;
          }
        }
        game.clues.push(clue);
      }
      if (across || down) cell.index = index++;
    });
  });

    for (const clue of game.clues) {
      clue.text = puzzle.clues[clue.dir][clue.index];
    }

  const update = [];
  for (const [side, y, x] of SIDES.slice(0, sides)) {
    for (const id of game.cells.slice(y)[0].slice(x)[0].clues) {
      for (const [yy, xx] of game.clues[id].cells) {
        updateVision(game, side, yy, xx, update);
      }
    }
    game.urls[rand(Object.keys(DICT)).toLowerCase() +
        '-' + String(Date.now() % 1000).padStart(3, 0)] = side;
    game.names[side] = null;
    game.hints[side] = {count: 0, time: 0};
    game.score[side] = 0;
  }
  commitUpdate(game, update);

  return game;
}

function updateVision(game, side, y, x, update) {
  for (const id of game.cells[y][x].clues) {
    if (game.clues[id].visible[side]) continue;
    game.clues[id].visible[side] = true;
    update.push({type: 'clue', side, id});
    for (const list of [game.clues[id].cells, game.clues[id].walls]) {
      for (const [yy, xx] of list) {
        if (game.cells[yy][xx].visible[side]) continue;
        game.cells[yy][xx].visible[side] = true;
        update.push({type: 'cell', side, y: yy, x: xx});
      }
    }
  }
}

function isVisible(game, thing, side) {
  if (side) return game.phase != 'locked' && thing.visible[side];
  return Object.values(thing.visible).some(v => v);
}

function renderCell(game, cell, side) {
  const {status, guess, timeout, actual, clues, index} = cell;
  if (!isVisible(game, cell, side)) return {};
  if (status == 'wall') return {status};
  if (status != 'blank') return {status, clues, index, guess: actual};
  if (!side) return {status, clues, index};
  return {status, clues, index, guess: guess[side], timeout: timeout[side]};
}

function renderClue(game, clue, side) {
  const {status, dir, index, cells, text} = clue;
  if (!isVisible(game, clue, side)) return {dir, index};
  return {status, dir, index, cells, text};
}

function renderHints(game, side) {
  if (!side || game.phase == 'locked') return undefined;
  const {count, time} = game.hints[side];
  const plus = parseInt((Date.now() - time) / HINT_TIME);
  if (count + plus >= HINT_CAP) return {count: HINT_CAP};
  return {count: count + plus, next: time + (plus + 1) * HINT_TIME};
}

function renderScore(game, side) {
  return side ? {[side]: game.score[side]} : Object.assign({}, game.score);
}

function renderGame(game, side) {
  return {
    cells: game.cells.map(row => row.map(cell => renderCell(game, cell, side))),
    clues: game.clues.map(clue => renderClue(game, clue, side)),
    log: side ? undefined : game.log,
    hints: renderHints(game, side),
    score: renderScore(game, side),
    total: game.total,
    start: game.start,
    time: game.time,
    winner: game.winner,
    names: game.names,
  };
}

function commitUpdate(game, update) {
  const replies = [];
  for (const side of [, ...Object.keys(game.score)]) {
    const events = [];
    for (const entry of update) {
      if (side && entry.side && side != entry.side) continue;
      const {type, id, y, x} = entry;
      switch (type) {
        case 'hints':
          if (side) events.push({type, hints: renderHints(game, side)});
          break;
        case 'score':
          events.push({type, score: renderScore(game, side)});
          break;
        case 'cell':
          const cell = renderCell(game, game.cells[y][x], side);
          if (cell.status) events.push({type, y, x, cell});
          break;
        case 'clue':
          const clue = renderClue(game, game.clues[id], side);
          if (clue.status) events.push({type, id, clue});
          break;
      }
    }
    if (events.length) replies.push({side, events});
    if (events.length && !side) game.log.push({time: Date.now(), events});
  }
  return replies;
}

function processGuess(game, side, {y, x, key}) {
  const update = [];
  let guess = String(key).toUpperCase();
  if (game.phase == 'started' && game.cells[y] && game.cells[y][x]) {
    const cell = game.cells[y][x];
    if (cell.status == 'blank' && cell.visible[side] &&
        !(cell.timeout[side] && cell.timeout[side] > Date.now())) {
      const {count, next} = renderHints(game, side);
      if (key ? cell.actual == guess : count > 0) {
        cell.status = side;
        update.push({type: 'cell', y, x});
        updateVision(game, side, y, x, update);
        for (const id of game.cells[y][x].clues) {
          if (game.clues[id].cells.every(
              ([y, x]) => game.cells[y][x].status != 'blank')) {
            game.clues[id].status = 'done';
            update.push({type: 'clue', id});
          }
        }
        ++game.score[side];
        update.push({type: 'score', side});
        if (!key) {
          game.hints[side].count = count - 1;
          game.hints[side].time = next ? next - HINT_TIME : Date.now();
          update.push({type: 'hints', side});
        }
      } else if (key && cell.guess[side] != guess) {
        cell.guess[side] = guess;
        cell.timeout[side] = Date.now() + GUESS_TIME;
        update.push({type: 'cell', side, y, x});
      }
    }
  }
  return commitUpdate(game, update);
}

function checkVictory(game) {
  const board = [];
  let sum = 0;
  for (const side in game.score) {
    sum += game.score[side];
    board.push({side, score: game.score[side]});
  }
  board.sort((a, b) => b.score - a.score);
  const {side, score} = board.shift();
  const force = new Date > game.start + game.time;
  if (force || game.total == sum) {
    game.phase = 'finished';
    game.winner = 'nobody';
  }
  if (score > board[0].score + (force ? 0 : game.total - sum)) {
    game.phase = 'finished';
    game.winner = side;
  }
}

module.exports = {
  renderGame,
  renderHints,
  processGuess,
  checkVictory,
};

async function pregenerate() {
	// first, you must specify either a --puz or a --dir.
	// --puz will generate everything to that one puz file.
	// --dir will iterate though the directory. only for casual mode.
	
	// assuming you did not --dir, 
	// you can choose to --tourney. this is a csv that will enable tourney mode with the listed players as input for the tournament.
	// 
	// assuming you did --tourney, --playernum takes effect, allowing you to make a 4p or 3p game/tournament.
	//
	// assuming you did not --tourney,  --games will determine how many games with an identical puz file are generated. by default it is set to GAMES.
	// in tourney mode, --url can be set to change the base of the url.

	const num = argv.playernum ? Number(argv.playernum) : 2; // only takes effect in tourney generation
	const base_url = argv.url ? argv.url : URL_PREFIX;
	const games_generated = argv.games ? Number(argv.games) : GAMES; // only takes effect in casual generation

  if (argv.tourney && argv.puz) {
    const puz = puzjs.decode(fs.readFileSync(argv.puz));
    const lines = fs.readFileSync(argv.tourney, 'utf8').trim().split('\n')
        .map(line => line.split(',')).sort(() => Math.random() - 0.5);
    let count = 0;
    while (lines.length >= 2) {
      const game = await createGame(num, puz, true);
      game.id = /^.*(.*)\.puz$/.exec(argv.puz)[1] +
          '-' + ('' + ++count).padStart(3, 0);
      for (const url in game.urls) {
        const [id, name] = lines.shift();
        game.names[game.urls[url]] = name;
        console.log(base_url + url, [id, game.id, game.urls[url], name].join(','));
        await fs.promises.symlink(`${game.id}.json`,
            `${__dirname}/save/${url}.json`);
      }
      await fs.promises.writeFile(`${__dirname}/save/${game.id}.json`,
          JSON.stringify(game, null, 2), 'utf8');
    }
    for (const [id, name] of lines) console.log([id, 'BYE',,, name].join(','));
  } else if (argv.puz) {

    const puz = puzjs.decode(fs.readFileSync(argv.puz));

    const games = [];
    for (let i = 0; i < 3; ++i) {
      (async () => {
        for (let j = 0; j < games_generated; j++) {
          try {
            games.push(await createGame(num, puz, false));
          } catch {}
        }
      })();
    }
    let count = 0;
    for (let j = 0; j < games_generated; j++) {
      await new Promise(res => setTimeout(res, 3000 * Math.random() + 1000));
      if (!games.length) continue;
      const game = games.shift();
      game.id = Date.now();
      console.log(++count, game.id, JSON.stringify(game.urls));
      await fs.promises.writeFile(`${__dirname}/made/${game.id}.json`,
          JSON.stringify(game, null, 2), 'utf8');
    }
	  
    } else if (argv.dir) {
	    console.log("ERROR. Not currently supported.");
  } else {
    console.log("Error. Invalid input arguments.");
  }
}

if (require.main == module) pregenerate();
