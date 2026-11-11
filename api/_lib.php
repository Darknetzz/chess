<?php
declare(strict_types=1);

// Shared bootstrap for the JSON API: SQLite, sessions, CSRF, helpers.

const MAX_BODY = 2_000_000;
const MOVE_RE = '/^[a-h][1-8][a-h][1-8][qrbn]?$/';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

set_exception_handler(function (Throwable $e): void {
    error_log('chess api: ' . $e);
    if (!headers_sent()) http_response_code(500);
    echo json_encode(['error' => 'Server error']);
});

function fail(int $code, string $msg): never
{
    http_response_code($code);
    echo json_encode(['error' => $msg]);
    exit;
}

function respond(mixed $data): never
{
    echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    exit;
}

function method(): string
{
    return $_SERVER['REQUEST_METHOD'] ?? 'GET';
}

function db(): PDO
{
    static $pdo = null;
    if ($pdo) return $pdo;
    $dir = getenv('DATA_DIR') ?: dirname(__DIR__) . '/data';
    if (!is_dir($dir) && !mkdir($dir, 0770, true) && !is_dir($dir)) {
        throw new RuntimeException("Cannot create data dir $dir");
    }
    $pdo = new PDO('sqlite:' . $dir . '/chess.sqlite', null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
    $pdo->exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    migrate($pdo);
    return $pdo;
}

function migrate(PDO $pdo): void
{
    if ((int)$pdo->query('PRAGMA user_version')->fetchColumn() >= 1) return;
    $pdo->exec(<<<SQL
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY,
            username TEXT NOT NULL UNIQUE COLLATE NOCASE,
            pass_hash TEXT NOT NULL,
            settings TEXT NOT NULL DEFAULT '{}',
            created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS games (
            id INTEGER PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            start_fen TEXT NOT NULL,
            moves TEXT NOT NULL DEFAULT '',
            result TEXT NOT NULL DEFAULT '*',
            termination TEXT NOT NULL DEFAULT '',
            mode TEXT NOT NULL DEFAULT 'free',
            human_color TEXT NOT NULL DEFAULT 'w',
            bot_level INTEGER,
            white TEXT NOT NULL DEFAULT '',
            black TEXT NOT NULL DEFAULT '',
            title TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS games_user ON games(user_id, updated_at DESC);
        CREATE TABLE IF NOT EXISTS login_attempts (
            key TEXT NOT NULL,
            ts INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS login_attempts_key ON login_attempts(key, ts);
        PRAGMA user_version = 1;
        SQL);
}

function start_session(): void
{
    if (session_status() === PHP_SESSION_ACTIVE) return;
    $https = ($_SERVER['HTTPS'] ?? '') === 'on' || ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https';
    session_name('chess_sid');
    session_set_cookie_params([
        'lifetime' => 60 * 60 * 24 * 30,
        'path' => '/',
        'secure' => $https,
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
    ini_set('session.use_strict_mode', '1');
    ini_set('session.gc_maxlifetime', (string)(60 * 60 * 24 * 30));
    session_start();
}

/** State-changing requests must carry the custom header and a JSON body (blocks cross-site form posts). */
function check_csrf(): void
{
    if (method() === 'GET') return;
    if (($_SERVER['HTTP_X_REQUESTED_WITH'] ?? '') !== 'chess') fail(403, 'Missing CSRF header');
    $ct = $_SERVER['CONTENT_TYPE'] ?? '';
    if ($ct !== '' && !str_starts_with($ct, 'application/json')) fail(415, 'JSON required');
}

function body(): array
{
    $raw = file_get_contents('php://input', false, null, 0, MAX_BODY + 1);
    if ($raw === false || $raw === '') return [];
    if (strlen($raw) > MAX_BODY) fail(413, 'Request too large');
    $data = json_decode($raw, true);
    if (!is_array($data)) fail(400, 'Invalid JSON');
    return $data;
}

function user_id(): ?int
{
    start_session();
    return isset($_SESSION['uid']) ? (int)$_SESSION['uid'] : null;
}

function require_user(): int
{
    return user_id() ?? fail(401, 'Not logged in');
}

function client_ip(): string
{
    return $_SERVER['REMOTE_ADDR'] ?? '?';
}

function str_field(array $a, string $k, int $max, string $default = ''): string
{
    $v = $a[$k] ?? $default;
    if (!is_string($v)) fail(400, "Invalid $k");
    $v = trim($v);
    if (mb_strlen($v) > $max) fail(400, "$k too long");
    return $v;
}

check_csrf();
