<?php
declare(strict_types=1);
require __DIR__ . '/_lib.php';

const MAX_FAILS = 10;
const FAIL_WINDOW = 15 * 60;

$action = $_GET['a'] ?? 'me';

function registration_open(): bool
{
    $v = getenv('REGISTRATION_OPEN');
    return $v === false || !in_array(strtolower($v), ['0', 'false', 'no', 'off'], true);
}

function me(?int $uid): array
{
    $out = ['user' => null, 'registration' => registration_open()];
    if ($uid === null) return $out;
    $st = db()->prepare('SELECT username, settings FROM users WHERE id = ?');
    $st->execute([$uid]);
    $row = $st->fetch();
    if (!$row) {
        $_SESSION = [];
        session_destroy();
        return $out;
    }
    $out['user'] = ['username' => $row['username'], 'settings' => json_decode($row['settings'], true) ?: new stdClass()];
    return $out;
}

function login_session(int $uid): void
{
    start_session();
    session_regenerate_id(true);
    $_SESSION['uid'] = $uid;
}

function hash_password(string $pw): string
{
    return password_hash($pw, defined('PASSWORD_ARGON2ID') ? PASSWORD_ARGON2ID : PASSWORD_DEFAULT);
}

if (method() === 'GET') {
    if ($action !== 'me') fail(405, 'Method not allowed');
    respond(me(user_id()));
}
if (method() !== 'POST') fail(405, 'Method not allowed');

$in = body();

switch ($action) {
    case 'register':
        if (!registration_open()) fail(403, 'Registration is closed');
        $username = str_field($in, 'username', 24);
        $password = $in['password'] ?? '';
        if (!preg_match('/^[A-Za-z0-9_-]{3,24}$/', $username)) fail(400, 'Username: 3–24 letters, digits, _ or -');
        if (!is_string($password) || strlen($password) < 8 || strlen($password) > 1024) fail(400, 'Password must be at least 8 characters');
        $st = db()->prepare('INSERT INTO users (username, pass_hash, created_at) VALUES (?, ?, ?) ON CONFLICT(username) DO NOTHING');
        $st->execute([$username, hash_password($password), time()]);
        if ($st->rowCount() === 0) fail(409, 'Username is taken');
        login_session((int)db()->lastInsertId());
        respond(me(user_id()));

    case 'login':
        $username = str_field($in, 'username', 64);
        $password = $in['password'] ?? '';
        if (!is_string($password)) fail(400, 'Invalid password');
        $pdo = db();
        $key = client_ip() . '|' . strtolower($username);
        $pdo->prepare('DELETE FROM login_attempts WHERE ts < ?')->execute([time() - FAIL_WINDOW]);
        $st = $pdo->prepare('SELECT COUNT(*) FROM login_attempts WHERE key = ?');
        $st->execute([$key]);
        if ((int)$st->fetchColumn() >= MAX_FAILS) fail(429, 'Too many failed attempts, try again later');

        $st = $pdo->prepare('SELECT id, pass_hash FROM users WHERE username = ?');
        $st->execute([$username]);
        $row = $st->fetch();
        // Verify against a dummy hash when the user doesn't exist to keep timing similar.
        $hash = $row['pass_hash'] ?? '$argon2id$v=19$m=65536,t=4,p=1$V2dlRHhCVlRLMmNnR2RqMw$EYW+BmZLb3apm51jJCp4q8Iwh6vtYGTdnXlENynexZA';
        if (!password_verify($password, $hash) || !$row) {
            $pdo->prepare('INSERT INTO login_attempts (key, ts) VALUES (?, ?)')->execute([$key, time()]);
            fail(401, 'Wrong username or password');
        }
        if (password_needs_rehash($row['pass_hash'], defined('PASSWORD_ARGON2ID') ? PASSWORD_ARGON2ID : PASSWORD_DEFAULT)) {
            $pdo->prepare('UPDATE users SET pass_hash = ? WHERE id = ?')->execute([hash_password($password), $row['id']]);
        }
        $pdo->prepare('DELETE FROM login_attempts WHERE key = ?')->execute([$key]);
        login_session((int)$row['id']);
        respond(me(user_id()));

    case 'logout':
        start_session();
        $_SESSION = [];
        session_destroy();
        setcookie(session_name(), '', ['expires' => time() - 3600, 'path' => '/', 'httponly' => true, 'samesite' => 'Lax']);
        respond(['ok' => true]);

    default:
        fail(404, 'Unknown action');
}
