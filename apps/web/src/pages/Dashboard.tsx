import { Link } from 'react-router-dom';
import { useAuth } from '../auth.js';
import { Shell } from '../Shell.js';

export function DashboardPage() {
  const { user } = useAuth();
  if (!user) return null;
  return (
    <Shell>
      <h1>Dashboard</h1>
      <p>
        Signed in as <strong>{user.username}</strong> ({user.role}).
      </p>
      {user.role === 'admin' && (
        <ul>
          <li>
            <Link to="/admin/settings">System settings (registration)</Link>
          </li>
          <li>
            <Link to="/admin/users">User management</Link>
          </li>
        </ul>
      )}
    </Shell>
  );
}
