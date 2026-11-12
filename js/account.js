// Login / register / logout UI. Hidden entirely when the API isn't available.
/* global $ */
import { api } from './api.js';

/**
 * @param {object} opts
 *   onLogin(user)    -> after a successful login/registration
 *   beforeLogout()   -> awaited before the session is dropped (flush saves)
 *   onLogout()       -> after logout
 */
export function initAccount({ onLogin, beforeLogout, onLogout }) {
  const $modal = $('#login-modal');
  let busy = false;

  function render() {
    $('#account').prop('hidden', !api.available);
    $('#account-name').text(api.user ? api.user.username : 'Guest');
    $('#login-btn').prop('hidden', !api.available || !!api.user);
    $('#logout-btn').prop('hidden', !api.user);
    $('#register-submit').prop('hidden', !api.registration);
  }

  $('#login-btn').on('click', () => {
    $('#login-error').text('');
    $('#login-pass').val('');
    // Non-modal on purpose: password managers (Bitwarden) fight showModal() dialogs for the top layer
    // and disable their inline menu. The backdrop is CSS and the page behind is made inert instead.
    $modal[0].show();
    $('main').prop('inert', true);
    $('#login-user').trigger('focus');
  });
  $modal.on('close', () => $('main').prop('inert', false));
  $modal.on('keydown', (e) => {
    if (e.key === 'Escape') $modal[0].close();
  });
  $('#login-close').on('click', () => $modal[0].close());

  $('#login-form').on('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    const register = e.originalEvent?.submitter?.value === 'register';
    const username = String($('#login-user').val()).trim();
    const password = String($('#login-pass').val());
    busy = true;
    $('#login-error').text(register ? 'Creating account…' : 'Logging in…');
    try {
      const user = await api.login(username, password, register);
      $modal[0].close();
      $('#login-pass').val('');
      render();
      await onLogin(user);
    } catch (err) {
      $('#login-error').text(err.message || String(err));
    } finally {
      busy = false;
    }
  });

  $('#logout-btn').on('click', async () => {
    try {
      await beforeLogout();
      await api.logout();
    } catch (err) {
      console.error(err);
    }
    api.user = null;
    render();
    onLogout();
  });

  render();
  return { render };
}
