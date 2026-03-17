/**
 * OpenAudit Philippines - Authentication System
 * Simple client-side auth with localStorage
 *
 * NOTE: This is NOT secure for sensitive data. It's a basic access gate
 * suitable for limiting access to a research team. For production use
 * with sensitive data, implement server-side authentication.
 */

// Default users (will be copied to localStorage on first load)
const DEFAULT_USERS = [
  { username: 'researcher1', password: 'OpenAudit2024!', name: 'Researcher 1' },
  { username: 'researcher2', password: 'AuditData2024!', name: 'Researcher 2' },
  { username: 'researcher3', password: 'COATracker24!', name: 'Researcher 3' },
  { username: 'researcher4', password: 'LGUMonitor24!', name: 'Researcher 4' },
  { username: 'admin', password: 'AdminAccess2024!', name: 'Administrator' }
];

const AUTH_KEY = 'openaudit_auth';
const USERS_KEY = 'openaudit_users';
const SESSION_DURATION = 24 * 60 * 60 * 1000; // 24 hours

// Simple hash function (not cryptographically secure, but sufficient for basic access control)
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return 'h' + Math.abs(hash).toString(16);
}

// Initialize users in localStorage if not present
function initUsers() {
  if (!localStorage.getItem(USERS_KEY)) {
    const hashedUsers = DEFAULT_USERS.map(u => ({
      username: u.username,
      passwordHash: simpleHash(u.password),
      name: u.name
    }));
    localStorage.setItem(USERS_KEY, JSON.stringify(hashedUsers));
  }
}

// Get users from localStorage
function getUsers() {
  initUsers();
  return JSON.parse(localStorage.getItem(USERS_KEY) || '[]');
}

// Save users to localStorage
function saveUsers(users) {
  localStorage.setItem(USERS_KEY, JSON.stringify(users));
}

// Check if user is authenticated
function isAuthenticated() {
  const auth = localStorage.getItem(AUTH_KEY);
  if (!auth) return false;

  try {
    const session = JSON.parse(auth);
    if (Date.now() > session.expires) {
      localStorage.removeItem(AUTH_KEY);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

// Get current user
function getCurrentUser() {
  const auth = localStorage.getItem(AUTH_KEY);
  if (!auth) return null;

  try {
    const session = JSON.parse(auth);
    if (Date.now() > session.expires) {
      return null;
    }
    return session.user;
  } catch {
    return null;
  }
}

// Login
function login(username, password) {
  const users = getUsers();
  const user = users.find(u => u.username === username.toLowerCase());

  if (!user) {
    return { success: false, error: 'Invalid username or password' };
  }

  if (user.passwordHash !== simpleHash(password)) {
    return { success: false, error: 'Invalid username or password' };
  }

  const session = {
    user: { username: user.username, name: user.name },
    expires: Date.now() + SESSION_DURATION
  };

  localStorage.setItem(AUTH_KEY, JSON.stringify(session));
  return { success: true };
}

// Logout
function logout() {
  localStorage.removeItem(AUTH_KEY);
  window.location.href = 'login.html';
}

// Change password
function changePassword(currentPassword, newPassword) {
  const currentUser = getCurrentUser();
  if (!currentUser) {
    return { success: false, error: 'Not logged in' };
  }

  const users = getUsers();
  const userIndex = users.findIndex(u => u.username === currentUser.username);

  if (userIndex === -1) {
    return { success: false, error: 'User not found' };
  }

  // Verify current password
  if (users[userIndex].passwordHash !== simpleHash(currentPassword)) {
    return { success: false, error: 'Current password is incorrect' };
  }

  // Validate new password
  if (newPassword.length < 8) {
    return { success: false, error: 'New password must be at least 8 characters' };
  }

  // Update password
  users[userIndex].passwordHash = simpleHash(newPassword);
  saveUsers(users);

  return { success: true };
}

// Redirect to login if not authenticated
function checkAuth() {
  if (!isAuthenticated()) {
    window.location.href = 'login.html';
  }
}

// Initialize on load
initUsers();
