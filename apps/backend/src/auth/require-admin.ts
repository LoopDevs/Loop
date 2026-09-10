import { requireStaff } from './require-staff.js';

// 404 (never 403) on non-admin to avoid leaking admin surface existence — ADR 037
export const requireAdmin = requireStaff('admin');
