import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from '@/auth';
import { RequireAuth, RequireAdmin } from '@/guards';
import { I18nProvider } from '@/i18n';
import { ThemeProvider } from '@/components/theme-provider';
import { Toaster } from '@/components/ui/sonner';
import { LoginPage } from '@/pages/Login';
import { RegisterPage } from '@/pages/Register';
import { DashboardPage } from '@/pages/Dashboard';
import { UsersPage } from '@/pages/Users';
import { SettingsPage } from '@/pages/Settings';
import { CredentialsPage } from '@/pages/Credentials';
import { TokensPage } from '@/pages/Tokens';
import { McpManagementPage } from '@/pages/McpManagement';
import { ProfilesPage } from '@/pages/Profiles';
import { ResourcesPage } from '@/pages/Resources';
import { SkillHubPage } from '@/pages/SkillHub';
import { MachinesPage } from '@/pages/Machines';
import { MachineDetailPage } from '@/pages/MachineDetail';
import { ChatPage } from '@/pages/Chat';

export function App() {
  return (
    <I18nProvider>
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
        <AuthProvider>
          <BrowserRouter>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route path="/register" element={<RegisterPage />} />
              <Route
                path="/"
                element={
                  <RequireAuth>
                    <DashboardPage />
                  </RequireAuth>
                }
              />
              <Route
                path="/machines"
                element={
                  <RequireAuth>
                    <MachinesPage />
                  </RequireAuth>
                }
              />
              <Route
                path="/machines/:id"
                element={
                  <RequireAuth>
                    <MachineDetailPage />
                  </RequireAuth>
                }
              />
              <Route
                path="/chat"
                element={
                  <RequireAuth>
                    <ChatPage />
                  </RequireAuth>
                }
              />
              <Route
                path="/credentials"
                element={
                  <RequireAuth>
                    <CredentialsPage />
                  </RequireAuth>
                }
              />
              <Route
                path="/tokens"
                element={
                  <RequireAuth>
                    <TokensPage />
                  </RequireAuth>
                }
              />
              <Route
                path="/mcp-servers"
                element={
                  <RequireAuth>
                    <McpManagementPage />
                  </RequireAuth>
                }
              />
              <Route
                path="/profiles"
                element={
                  <RequireAuth>
                    <ProfilesPage />
                  </RequireAuth>
                }
              />
              <Route
                path="/resources"
                element={
                  <RequireAuth>
                    <ResourcesPage />
                  </RequireAuth>
                }
              />
              <Route
                path="/skills/hub"
                element={
                  <RequireAuth>
                    <SkillHubPage />
                  </RequireAuth>
                }
              />
              <Route
                path="/admin/*"
                element={
                  <RequireAuth>
                    <RequireAdmin>
                      <Routes>
                        <Route path="users" element={<UsersPage />} />
                        <Route path="settings" element={<SettingsPage />} />
                        <Route path="*" element={<Navigate to="/admin/settings" replace />} />
                      </Routes>
                    </RequireAdmin>
                  </RequireAuth>
                }
              />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </BrowserRouter>
          <Toaster richColors closeButton />
        </AuthProvider>
      </ThemeProvider>
    </I18nProvider>
  );
}
