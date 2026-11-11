<?php
declare(strict_types=1);
require __DIR__ . '/_lib.php';

$uid = require_user();

if (method() === 'GET') {
    $st = db()->prepare('SELECT settings FROM users WHERE id = ?');
    $st->execute([$uid]);
    respond(json_decode((string)$st->fetchColumn(), true) ?: new stdClass());
}
if (method() !== 'PUT') fail(405, 'Method not allowed');

// Flat object of scalars only; the client owns the schema and ignores unknown keys.
$in = body();
if (count($in) > 64) fail(400, 'Too many settings');
$clean = [];
foreach ($in as $k => $v) {
    if (!is_string($k) || !preg_match('/^[A-Za-z][A-Za-z0-9]{0,31}$/', $k)) fail(400, 'Invalid setting key');
    if (is_string($v) && strlen($v) > 64) fail(400, "Setting $k too long");
    if (!is_scalar($v) && $v !== null) fail(400, "Setting $k must be a scalar");
    $clean[$k] = $v;
}
db()->prepare('UPDATE users SET settings = ? WHERE id = ?')->execute([json_encode($clean), $uid]);
respond($clean);
