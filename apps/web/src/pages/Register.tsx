import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '@/auth';
import { api } from '@/api';
import { AgentNexusError } from '@agent-nexus/sdk';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Brand } from '@/components/brand-mark';

export function RegisterPage() {
  const { register, user } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [registrationOpen, setRegistrationOpen] = useState<boolean | null>(null);

  // Fetch the public registration switch so the form can disable itself.
  useEffect(() => {
    api
      .getRegistration()
      .then((r) => setRegistrationOpen(r.allowRegistration))
      .catch(() => setRegistrationOpen(true));
  }, []);

  // Already signed in → go home.
  useEffect(() => {
    if (user) navigate('/', { replace: true });
  }, [user, navigate]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await register(username, password, email || undefined);
      navigate('/', { replace: true });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('register failed:', e);
      setError(
        e instanceof AgentNexusError
          ? e.message
          : `Registration failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setBusy(false);
    }
  }

  const closed = registrationOpen === false;

  return (
    <div className="bg-background flex min-h-svh flex-col items-center justify-center gap-6 p-4">
      <Brand size={30} />
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">Create account</CardTitle>
          <CardDescription>Register a new AgentNexus account</CardDescription>
        </CardHeader>
        <CardContent>
          {closed && (
            <Alert variant="destructive" className="mb-4">
              <AlertDescription>
                Registration is closed on this instance. Ask an admin for an account.
              </AlertDescription>
            </Alert>
          )}
          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <div className="grid gap-2">
              <Label htmlFor="username">Username</Label>
              <Input
                id="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                disabled={closed}
                autoComplete="username"
                spellCheck={false}
                required
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={closed}
                autoComplete="new-password"
                required
              />
              <p className="text-muted-foreground text-xs">Minimum 8 characters.</p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="email">Email (optional)</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={closed}
                autoComplete="email"
              />
            </div>
            <Button type="submit" disabled={busy || closed} className="w-full">
              {busy ? 'Creating…' : 'Register'}
            </Button>
            <p className="text-muted-foreground text-center text-sm">
              Already have an account?{' '}
              <Link to="/login" className="text-primary underline-offset-4 hover:underline">
                Sign in
              </Link>
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
