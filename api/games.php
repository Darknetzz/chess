<?php
declare(strict_types=1);
require __DIR__ . '/_lib.php';

const MAX_IMPORT = 500;
const MAX_MOVES = 1000;
const LIST_FIELDS = 'id, created_at, updated_at, result, termination, mode, human_color, bot_level, white, black, title, start_fen, moves, assisted';

$uid = require_user();
$pdo = db();
$id = isset($_GET['id']) ? (int)$_GET['id'] : null;

/** Validate and normalise a client game object into DB columns. */
function clean_game(array $g): array
{
    $moves = $g['moves'] ?? [];
    if (is_string($moves)) $moves = $moves === '' ? [] : explode(' ', $moves);
    if (!is_array($moves) || count($moves) > MAX_MOVES) fail(400, 'Invalid moves');
    foreach ($moves as $m) {
        if (!is_string($m) || !preg_match(MOVE_RE, $m)) fail(400, 'Invalid move');
    }
    $fen = str_field($g, 'startFen', 100);
    if (!preg_match('~^[pnbrqkPNBRQK1-8/]+ [wb] [KQkq-]+ [a-h1-8-]+ \d+ \d+$~', $fen)) fail(400, 'Invalid start FEN');
    $result = str_field($g, 'result', 7, '*');
    if (!in_array($result, ['1-0', '0-1', '1/2-1/2', '*'], true)) fail(400, 'Invalid result');
    $mode = str_field($g, 'mode', 8, 'free');
    if (!in_array($mode, ['free', 'bot', 'import', 'net'], true)) fail(400, 'Invalid mode');
    $color = str_field($g, 'humanColor', 1, 'w');
    if (!in_array($color, ['w', 'b'], true)) fail(400, 'Invalid colour');
    $level = $g['botLevel'] ?? null;
    if ($level !== null && (!is_int($level) || $level < 0 || $level > 20)) fail(400, 'Invalid bot level');
    $created = $g['createdAt'] ?? null;
    $created = is_int($created) && $created > 0 && $created <= time() + 86400 ? $created : time();
    return [
        'start_fen' => $fen,
        'moves' => implode(' ', $moves),
        'result' => $result,
        'termination' => str_field($g, 'termination', 64),
        'mode' => $mode,
        'human_color' => $color,
        'bot_level' => $level,
        'white' => str_field($g, 'white', 64),
        'black' => str_field($g, 'black', 64),
        'title' => str_field($g, 'title', 128),
        'assisted' => ($g['assisted'] ?? false) === true ? 1 : 0,
        'created_at' => $created,
    ];
}

function out(array $r): array
{
    return [
        'id' => (int)$r['id'],
        'createdAt' => (int)$r['created_at'],
        'updatedAt' => (int)$r['updated_at'],
        'startFen' => $r['start_fen'],
        'moves' => $r['moves'] === '' ? [] : explode(' ', $r['moves']),
        'result' => $r['result'],
        'termination' => $r['termination'],
        'mode' => $r['mode'],
        'humanColor' => $r['human_color'],
        'botLevel' => $r['bot_level'] === null ? null : (int)$r['bot_level'],
        'white' => $r['white'],
        'black' => $r['black'],
        'title' => $r['title'],
        'assisted' => (bool)$r['assisted'],
    ];
}

function insert(PDO $pdo, int $uid, array $c): int
{
    $st = $pdo->prepare('INSERT INTO games (user_id, created_at, updated_at, start_fen, moves, result, termination, mode, human_color, bot_level, white, black, title, assisted)
        VALUES (:uid, :created_at, :updated_at, :start_fen, :moves, :result, :termination, :mode, :human_color, :bot_level, :white, :black, :title, :assisted)');
    $st->execute(['uid' => $uid, 'updated_at' => time()] + $c);
    return (int)$pdo->lastInsertId();
}

function fetch_one(PDO $pdo, int $uid, int $id): array
{
    $st = $pdo->prepare('SELECT ' . LIST_FIELDS . ' FROM games WHERE id = ? AND user_id = ?');
    $st->execute([$id, $uid]);
    return $st->fetch() ?: fail(404, 'Game not found');
}

switch (method()) {
    case 'GET':
        if ($id !== null) respond(out(fetch_one($pdo, $uid, $id)));
        $limit = max(1, min(200, (int)($_GET['limit'] ?? 50)));
        $offset = max(0, (int)($_GET['offset'] ?? 0));
        $st = $pdo->prepare('SELECT ' . LIST_FIELDS . ' FROM games WHERE user_id = ? ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?');
        $st->bindValue(1, $uid, PDO::PARAM_INT);
        $st->bindValue(2, $limit, PDO::PARAM_INT);
        $st->bindValue(3, $offset, PDO::PARAM_INT);
        $st->execute();
        $games = array_map('out', $st->fetchAll());
        $st = $pdo->prepare('SELECT COUNT(*) FROM games WHERE user_id = ?');
        $st->execute([$uid]);
        respond(['games' => $games, 'total' => (int)$st->fetchColumn()]);

    case 'POST':
        $in = body();
        if (($_GET['a'] ?? '') === 'import') {
            $list = $in['games'] ?? null;
            if (!is_array($list) || !array_is_list($list) || count($list) > MAX_IMPORT) fail(400, 'Expected up to ' . MAX_IMPORT . ' games');
            $clean = array_map(fn($g) => is_array($g) ? clean_game($g) : fail(400, 'Invalid game'), $list);
            $pdo->beginTransaction();
            $ids = array_map(fn($c) => insert($pdo, $uid, $c), $clean);
            $pdo->commit();
            respond(['ids' => $ids]);
        }
        $newId = insert($pdo, $uid, clean_game($in));
        respond(out(fetch_one($pdo, $uid, $newId)));

    case 'PUT':
        if ($id === null) fail(400, 'Missing id');
        fetch_one($pdo, $uid, $id);
        $c = clean_game(body());
        unset($c['created_at']);
        $st = $pdo->prepare('UPDATE games SET updated_at = :updated_at, start_fen = :start_fen, moves = :moves, result = :result, termination = :termination,
            mode = :mode, human_color = :human_color, bot_level = :bot_level, white = :white, black = :black, title = :title, assisted = :assisted WHERE id = :id AND user_id = :uid');
        $st->execute(['updated_at' => time(), 'id' => $id, 'uid' => $uid] + $c);
        respond(out(fetch_one($pdo, $uid, $id)));

    case 'DELETE':
        if ($id === null) fail(400, 'Missing id');
        $st = $pdo->prepare('DELETE FROM games WHERE id = ? AND user_id = ?');
        $st->execute([$id, $uid]);
        if ($st->rowCount() === 0) fail(404, 'Game not found');
        respond(['ok' => true]);

    default:
        fail(405, 'Method not allowed');
}
