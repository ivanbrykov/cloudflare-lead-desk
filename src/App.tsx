import { Button } from './components/ui/Button';
import { Dialog } from './components/ui/Dialog';
import { type PipelineView } from './domain/schemas';
import { LeadDetailPage } from './leads/LeadDetailPage';
import { LeadsPage } from './leads/LeadsPage';
import { signIn, signOut, signUp, useSession } from './lib/auth-client';
import { request } from './lib/http';
import { quietFetch } from './lib/quiet-fetch';
import {
  initialRegistrationState,
  registrationReducer,
  type SignUpFailure,
} from './lib/registration-flow';
import { cn } from './lib/styles';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Copy,
  KeyRound,
  LayoutList,
  LogOut,
  Mail,
  PanelsTopLeft,
  Plus,
  Users,
} from 'lucide-react';
import { useReducer, useRef, useState } from 'react';
import { Link, Route, Switch, useLocation } from 'wouter';

type Invite = {
  createdAt: string;
  expiresAt: null | string;
  id: string;
  name: string;
  prefix: string;
  revokedAt: null | string;
  usedAt: null | string;
};

// Response type shared from the domain schema. Elysia 1.4 unwraps Standard
// Schema request schemas for Eden but not response schemas, so responses use
// this shared type with the existing typed fetch wrapper instead.
type Pipeline = PipelineView;
type StaffAccount = {
  disabledAt: null | string;
  email: string;
  id: string;
  name: string;
};

type Token = {
  createdAt: string;
  expiresAt: null | string;
  id: string;
  name: string;
  prefix: string;
  revokedAt: null | string;
};

const navigation = [
  { href: '/leads', icon: LayoutList, label: 'Leads' },
  { href: '/settings/invites', icon: Mail, label: 'Invitations' },
  { href: '/settings/staff', icon: Users, label: 'Staff' },
  { href: '/settings/tokens', icon: KeyRound, label: 'Tokens' },
];

const appQuery = {
  invites: () => ({
    queryFn: () => request<Invite[]>('/v1/invites'),
    queryKey: ['invites'],
  }),
  pipelines: () => ({
    queryFn: () => request<Pipeline[]>('/v1/pipelines'),
    queryKey: ['pipelines'],
  }),
  staff: () => ({
    queryFn: () => request<StaffAccount[]>('/v1/staff'),
    queryKey: ['staff'],
  }),
  tokens: () => ({
    queryFn: () => request<Token[]>('/v1/tokens'),
    queryKey: ['tokens'],
  }),
};

const ErrorState = ({
  error,
  onRetry,
}: {
  readonly error: unknown;
  readonly onRetry?: () => void;
}) => (
  <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-100">
    {error instanceof Error ? error.message : 'Something went wrong.'}
    {onRetry && (
      <button
        className="ml-3 font-semibold text-cyan-300 hover:text-cyan-200"
        onClick={onRetry}
        type="button"
      >
        Try again
      </button>
    )}
  </div>
);

const Shell = ({ children }: { readonly children: React.ReactNode }) => {
  const [location] = useLocation();
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 lg:grid lg:grid-cols-[14rem_1fr]">
      <aside className="border-b border-slate-800 bg-slate-900/70 p-4 lg:min-h-screen lg:border-b-0 lg:border-r">
        <Link
          className="mb-8 flex items-center gap-2 px-2 text-sm font-bold tracking-tight text-white"
          href="/leads"
        >
          <span className="grid size-7 place-items-center rounded-md bg-cyan-400 text-slate-950">
            <PanelsTopLeft size={16} />
          </span>
          Lead Desk
        </Link>
        <nav className="grid grid-cols-2 gap-1 sm:flex sm:flex-wrap lg:grid lg:grid-cols-1">
          {navigation.map((item) => {
            const Icon = item.icon;
            const active =
              location === item.href || location.startsWith(`${item.href}/`);
            return (
              <Link
                className={cn(
                  'flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition',
                  active
                    ? 'bg-slate-800 text-cyan-300'
                    : 'text-slate-400 hover:bg-slate-800/70 hover:text-slate-100',
                )}
                href={item.href}
                key={item.href}
              >
                <Icon size={16} />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="mt-6 border-t border-slate-800 pt-4">
          <button
            className="flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-slate-400 transition hover:bg-slate-800/70 hover:text-slate-100"
            onClick={() => {
              void signOut();
            }}
            type="button"
          >
            <LogOut size={16} />
            Sign out
          </button>
          <p className="mt-2 px-3 text-xs leading-relaxed text-slate-500">
            Cloudflare-native CRM alpha
          </p>
        </div>
      </aside>
      <main className="min-w-0">{children}</main>
    </div>
  );
};

const Header = ({
  action,
  eyebrow,
  title,
}: {
  readonly action?: React.ReactNode;
  readonly eyebrow?: string;
  readonly title: string;
}) => (
  <header className="flex flex-wrap items-end justify-between gap-4 border-b border-slate-800 px-5 py-5 sm:px-8">
    <div>
      {eyebrow && (
        <p className="mb-1 text-xs font-semibold uppercase tracking-[0.16em] text-cyan-400">
          {eyebrow}
        </p>
      )}
      <h1 className="text-2xl font-semibold tracking-tight text-white">
        {title}
      </h1>
    </div>
    {action}
  </header>
);

const TOKEN_DEFAULT_TTL_MS = 90 * 86_400_000;

const INVITE_DEFAULT_TTL_MS = 7 * 86_400_000;

const inviteStatus = (
  invite: Invite,
): 'active' | 'expired' | 'revoked' | 'used' => {
  if (invite.revokedAt) {
    return 'revoked';
  }

  if (invite.usedAt) {
    return 'used';
  }

  if (invite.expiresAt && new Date(invite.expiresAt).getTime() <= Date.now()) {
    return 'expired';
  }

  return 'active';
};

// datetime-local inputs only carry local wall-clock time, so shift the
// instant into local parts before handing it to the input element.
const toLocalInputValue = (date: Date) =>
  new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);

const localTimezoneLabel = () => {
  const offsetMinutes = -new Date().getTimezoneOffset();
  const absolute = Math.abs(offsetMinutes);
  const offset = `UTC${offsetMinutes < 0 ? '-' : '+'}${String(
    Math.floor(absolute / 60),
  ).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
  return `${Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'local'} (${offset})`;
};

const tokenStatus = (
  token: Token,
): 'active' | 'expired' | 'legacy' | 'revoked' => {
  if (token.revokedAt) {
    return 'revoked';
  }

  if (!token.expiresAt) {
    return 'legacy';
  }

  if (new Date(token.expiresAt).getTime() <= Date.now()) {
    return 'expired';
  }

  return 'active';
};

const statusTone = {
  active: 'text-emerald-300',
  expired: 'text-amber-300',
  legacy: 'text-sky-300',
  revoked: 'text-rose-300',
  used: 'text-violet-300',
} as const;

const CreateTokenDialog = ({
  defaultExpiration,
  onOpenChange,
  open,
}: {
  readonly defaultExpiration: string;
  readonly onOpenChange: (value: boolean) => void;
  readonly open: boolean;
}) => {
  const queryClient = useQueryClient();
  const [copyFailed, setCopyFailed] = useState(false);
  const [formError, setFormError] = useState<null | string>(null);
  const [name, setName] = useState('');
  const [rawToken, setRawToken] = useState<null | string>(null);
  // The parent remounts this dialog (via its key) on every open, so state is
  // always fresh: empty form, 90-day default matching the backend, no raw
  // token, and an idle create mutation.
  const [expiration, setExpiration] = useState(defaultExpiration);
  const create = useMutation({
    mutationFn: (input: { expiresAt?: string; name: string }) =>
      request<Token & { token: string }>('/v1/tokens', {
        body: JSON.stringify(input),
        method: 'POST',
      }),
    onSuccess: (created) => {
      // Keep the dialog open: the raw token is shown once and must stay
      // visible until the staff member explicitly dismisses it.
      setFormError(null);
      setRawToken(created.token);
      queryClient.invalidateQueries({ queryKey: ['tokens'] });
    },
  });

  // Escape, backdrop, and the close control all route through here. While a
  // create is in flight, dismissal is ignored so a generated token can never
  // be lost behind a closed dialog.
  const handleOpenChange = (value: boolean) => {
    if (!value && create.isPending) {
      return;
    }

    onOpenChange(value);
  };

  const submit = () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setFormError('Enter a token name.');
      return;
    }

    // The input value is local wall-clock time; new Date parses it as local
    // time and toISOString converts it to the UTC ISO string the API expects.
    const parsedExpiration = expiration ? new Date(expiration) : undefined;
    if (
      parsedExpiration &&
      (!Number.isFinite(parsedExpiration.getTime()) ||
        parsedExpiration.getTime() <= Date.now())
    ) {
      setFormError('Expiration must be in the future.');
      return;
    }

    setFormError(null);
    create.mutate({
      expiresAt: parsedExpiration?.toISOString(),
      name: trimmedName,
    });
  };

  const copyToken = async () => {
    if (!rawToken) {
      return;
    }

    try {
      await navigator.clipboard.writeText(rawToken);
      setCopyFailed(false);
    } catch {
      // Clipboard access can be denied; the raw text stays visible and
      // selectable instead of being replaced by a "copied" state.
      setCopyFailed(true);
    }
  };

  return (
    <Dialog
      onOpenChange={handleOpenChange}
      open={open}
      title="Create token"
    >
      {rawToken ? (
        <div className="grid gap-4">
          <p className="text-sm text-slate-300">
            Token created. It will not be shown again.
          </p>
          <code className="block break-all rounded-md border border-slate-700 bg-slate-950 p-3 font-mono text-xs text-slate-100">
            {rawToken}
          </code>
          {copyFailed && (
            <p className="text-sm text-amber-300">
              Clipboard unavailable — select the text above to copy it.
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              onClick={() => {
                void copyToken();
              }}
            >
              Copy token
            </Button>
            <Button
              onClick={() => handleOpenChange(false)}
              tone="secondary"
            >
              Done
            </Button>
          </div>
        </div>
      ) : (
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <label className="grid gap-1 text-sm text-slate-300">
            Token name
            <input
              onChange={(event) => setName(event.target.value)}
              placeholder="Website form intake"
              value={name}
            />
          </label>
          <div className="grid gap-1">
            <label className="grid gap-1 text-sm text-slate-300">
              Expiration
              <input
                onChange={(event) => setExpiration(event.target.value)}
                type="datetime-local"
                value={expiration}
              />
            </label>
            <p className="text-xs text-slate-500">
              Local time ({localTimezoneLabel()})
            </p>
          </div>
          {formError && <p className="text-sm text-rose-300">{formError}</p>}
          {create.error && <ErrorState error={create.error} />}
          <div className="flex justify-end gap-2">
            <Button
              disabled={create.isPending}
              onClick={() => handleOpenChange(false)}
              tone="secondary"
            >
              Cancel
            </Button>
            <Button
              disabled={create.isPending || !name.trim()}
              type="submit"
            >
              Create token
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
};

const TokensPage = () => {
  const queryClient = useQueryClient();
  const [createNonce, setCreateNonce] = useState(0);
  const [defaultExpiration, setDefaultExpiration] = useState('');
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const tokens = useQuery(appQuery.tokens());
  const revoke = useMutation({
    mutationFn: (id: string) =>
      request(`/v1/tokens/${id}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tokens'] }),
  });
  return (
    <>
      <Header
        action={
          <Button
            onClick={() => {
              setCreateNonce((value) => value + 1);
              setDefaultExpiration(
                toLocalInputValue(new Date(Date.now() + TOKEN_DEFAULT_TTL_MS)),
              );
              setShowCreateDialog(true);
            }}
          >
            <Plus size={16} /> Create token
          </Button>
        }
        eyebrow="Integrations"
        title="API tokens"
      />
      <div className="p-5 sm:p-8">
        {tokens.isPending ? (
          <p className="text-slate-400">Loading tokens…</p>
        ) : tokens.error ? (
          <ErrorState error={tokens.error} />
        ) : tokens.data?.length ? (
          <div className="overflow-x-auto rounded-xl border border-slate-800">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-900 text-xs uppercase tracking-wider text-slate-400">
                <tr>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Created</th>
                  <th className="px-4 py-3">Expires</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Revoke</th>
                </tr>
              </thead>
              <tbody>
                {tokens.data.map((token) => (
                  <tr
                    className="border-t border-slate-800"
                    key={token.id}
                  >
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-100">{token.name}</p>
                      <code className="font-mono text-xs text-slate-500">
                        {token.prefix}…
                      </code>
                    </td>
                    <td className="px-4 py-3 text-slate-500">
                      {new Date(token.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-slate-400">
                      {token.expiresAt
                        ? new Date(token.expiresAt).toLocaleDateString()
                        : 'No expiry (legacy)'}
                    </td>
                    <td
                      className={cn(
                        'px-4 py-3',
                        statusTone[tokenStatus(token)],
                      )}
                    >
                      {tokenStatus(token)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end">
                        {!token.revokedAt && (
                          <Button
                            disabled={revoke.isPending}
                            onClick={() => revoke.mutate(token.id)}
                            tone="danger"
                          >
                            Revoke
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-slate-400">No API tokens yet.</p>
        )}
        {revoke.error && (
          <div className="mt-4">
            <ErrorState error={revoke.error} />
          </div>
        )}
      </div>
      {showCreateDialog ? (
        <CreateTokenDialog
          defaultExpiration={defaultExpiration}
          key={createNonce}
          onOpenChange={(value) => {
            if (!value) {
              setShowCreateDialog(false);
            }
          }}
          open={showCreateDialog}
        />
      ) : null}
    </>
  );
};

const CreateInviteDialog = ({
  defaultExpiration,
  onOpenChange,
  open,
}: {
  readonly defaultExpiration: string;
  readonly onOpenChange: (value: boolean) => void;
  readonly open: boolean;
}) => {
  const queryClient = useQueryClient();
  const [copyFailed, setCopyFailed] = useState(false);
  const [formError, setFormError] = useState<null | string>(null);
  const [name, setName] = useState('');
  const [rawToken, setRawToken] = useState<null | string>(null);
  // The parent remounts this dialog (via its key) on every open, so state is
  // always fresh: empty form, 7-day default matching the backend, no raw
  // token, and an idle create mutation.
  const [expiration, setExpiration] = useState(defaultExpiration);
  const create = useMutation({
    mutationFn: (input: { expiresAt?: string; name: string }) =>
      request<Invite & { token: string }>('/v1/invites', {
        body: JSON.stringify(input),
        method: 'POST',
      }),
    onSuccess: (created) => {
      // Keep the dialog open: the raw invite token is shown once and must
      // stay visible until the staff member explicitly dismisses it.
      setFormError(null);
      setRawToken(created.token);
      queryClient.invalidateQueries({ queryKey: ['invites'] });
    },
  });

  // Escape, backdrop, and the close control all route through here. While a
  // create is in flight, dismissal is ignored so a generated token can never
  // be lost behind a closed dialog.
  const handleOpenChange = (value: boolean) => {
    if (!value && create.isPending) {
      return;
    }

    onOpenChange(value);
  };

  const submit = () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setFormError('Enter an invite name.');
      return;
    }

    // The input value is local wall-clock time; new Date parses it as local
    // time and toISOString converts it to the UTC ISO string the API expects.
    const parsedExpiration = expiration ? new Date(expiration) : undefined;
    if (
      parsedExpiration &&
      (!Number.isFinite(parsedExpiration.getTime()) ||
        parsedExpiration.getTime() <= Date.now())
    ) {
      setFormError('Expiration must be in the future.');
      return;
    }

    setFormError(null);
    create.mutate({
      expiresAt: parsedExpiration?.toISOString(),
      name: trimmedName,
    });
  };

  const copyToken = async () => {
    if (!rawToken) {
      return;
    }

    try {
      await navigator.clipboard.writeText(rawToken);
      setCopyFailed(false);
    } catch {
      // Clipboard access can be denied; the raw text stays visible and
      // selectable instead of being replaced by a "copied" state.
      setCopyFailed(true);
    }
  };

  return (
    <Dialog
      onOpenChange={handleOpenChange}
      open={open}
      title="Create invite"
    >
      {rawToken ? (
        <div className="grid gap-4">
          <p className="text-sm text-slate-300">
            Invitation created. It will not be shown again.
          </p>
          <code className="block break-all rounded-md border border-slate-700 bg-slate-950 p-3 font-mono text-xs text-slate-100">
            {rawToken}
          </code>
          {copyFailed && (
            <p className="text-sm text-amber-300">
              Clipboard unavailable — select the text above to copy it.
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              onClick={() => {
                void copyToken();
              }}
            >
              <Copy size={16} /> Copy invite
            </Button>
            <Button
              onClick={() => handleOpenChange(false)}
              tone="secondary"
            >
              Done
            </Button>
          </div>
        </div>
      ) : (
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <label className="grid gap-1 text-sm text-slate-300">
            Invite name
            <input
              onChange={(event) => setName(event.target.value)}
              placeholder="Weekend onboarding"
              value={name}
            />
          </label>
          <div className="grid gap-1">
            <label className="grid gap-1 text-sm text-slate-300">
              Expiration
              <input
                onChange={(event) => setExpiration(event.target.value)}
                type="datetime-local"
                value={expiration}
              />
            </label>
            <p className="text-xs text-slate-500">
              Local time ({localTimezoneLabel()})
            </p>
          </div>
          {formError && <p className="text-sm text-rose-300">{formError}</p>}
          {create.error && <ErrorState error={create.error} />}
          <div className="flex justify-end gap-2">
            <Button
              disabled={create.isPending}
              onClick={() => handleOpenChange(false)}
              tone="secondary"
              type="button"
            >
              Cancel
            </Button>
            <Button
              disabled={create.isPending || !name.trim()}
              type="submit"
            >
              Create invite
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
};

const InvitesPage = () => {
  const queryClient = useQueryClient();
  const [createNonce, setCreateNonce] = useState(0);
  const [defaultExpiration, setDefaultExpiration] = useState('');
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const invites = useQuery(appQuery.invites());
  const revoke = useMutation({
    mutationFn: (id: string) =>
      request(`/v1/invites/${id}`, { method: 'DELETE' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['invites'] }),
  });
  return (
    <>
      <Header
        action={
          <Button
            onClick={() => {
              setCreateNonce((value) => value + 1);
              setDefaultExpiration(
                toLocalInputValue(new Date(Date.now() + INVITE_DEFAULT_TTL_MS)),
              );
              setShowCreateDialog(true);
            }}
          >
            <Plus size={16} /> Create invite
          </Button>
        }
        eyebrow="Integrations"
        title="Invitations"
      />
      <div className="p-5 sm:p-8">
        {invites.isPending ? (
          <p className="text-slate-400">Loading invitations…</p>
        ) : invites.error ? (
          <ErrorState error={invites.error} />
        ) : invites.data?.length ? (
          <div className="overflow-x-auto rounded-xl border border-slate-800">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-900 text-xs uppercase tracking-wider text-slate-400">
                <tr>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Created</th>
                  <th className="px-4 py-3">Expires</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Revoke</th>
                </tr>
              </thead>
              <tbody>
                {invites.data.map((invite) => (
                  <tr
                    className="border-t border-slate-800"
                    key={invite.id}
                  >
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-100">
                        {invite.name}
                      </p>
                      <code className="font-mono text-xs text-slate-500">
                        {invite.prefix}…
                      </code>
                    </td>
                    <td className="px-4 py-3 text-slate-500">
                      {new Date(invite.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-slate-400">
                      {invite.expiresAt
                        ? new Date(invite.expiresAt).toLocaleDateString()
                        : '—'}
                    </td>
                    <td
                      className={cn(
                        'px-4 py-3',
                        statusTone[inviteStatus(invite)],
                      )}
                    >
                      {inviteStatus(invite)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end">
                        {!invite.revokedAt && (
                          <Button
                            disabled={revoke.isPending}
                            onClick={() => revoke.mutate(invite.id)}
                            tone="danger"
                          >
                            Revoke
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-slate-400">No invites yet.</p>
        )}
        {revoke.error && (
          <div className="mt-4">
            <ErrorState error={revoke.error} />
          </div>
        )}
      </div>
      {showCreateDialog ? (
        <CreateInviteDialog
          defaultExpiration={defaultExpiration}
          key={createNonce}
          onOpenChange={(value) => {
            if (!value) {
              setShowCreateDialog(false);
            }
          }}
          open={showCreateDialog}
        />
      ) : null}
    </>
  );
};

const StaffPage = () => {
  const queryClient = useQueryClient();
  const { data: session } = useSession();
  const staff = useQuery(appQuery.staff());
  const setStatus = useMutation({
    mutationFn: (input: { disabled: boolean; id: string }) =>
      request<StaffAccount>(`/v1/staff/${input.id}`, {
        body: JSON.stringify({ disabled: input.disabled }),
        method: 'PATCH',
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['staff'] }),
  });
  return (
    <>
      <Header
        eyebrow="Integrations"
        title="Staff accounts"
      />
      <div className="p-5 sm:p-8">
        {staff.isPending ? (
          <p className="text-slate-400">Loading staff…</p>
        ) : staff.error ? (
          <ErrorState error={staff.error} />
        ) : staff.data?.length ? (
          <div className="overflow-x-auto rounded-xl border border-slate-800">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-900 text-xs uppercase tracking-wider text-slate-400">
                <tr>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Email</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {staff.data.map((account) => {
                  const disabled = Boolean(account.disabledAt);
                  // The server is the authority on self-disable and
                  // last-enabled protection; hiding the control for the
                  // signed-in account keeps the list unambiguous without
                  // pretending the client enforces the rule.
                  const isSelf = session?.user?.id === account.id;
                  return (
                    <tr
                      className="border-t border-slate-800"
                      key={account.id}
                    >
                      <td className="px-4 py-3 font-medium text-slate-100">
                        {account.name}
                      </td>
                      <td className="px-4 py-3 text-slate-500">
                        {account.email}
                      </td>
                      <td
                        className={cn(
                          'px-4 py-3',
                          disabled ? 'text-rose-300' : 'text-emerald-300',
                        )}
                      >
                        {disabled ? 'disabled' : 'enabled'}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end">
                          {isSelf ? null : (
                            <Button
                              disabled={setStatus.isPending}
                              onClick={() =>
                                setStatus.mutate({
                                  disabled: !disabled,
                                  id: account.id,
                                })
                              }
                              tone={disabled ? 'secondary' : 'danger'}
                            >
                              {disabled ? 'Enable' : 'Disable'}
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-slate-400">No staff accounts yet.</p>
        )}
        {setStatus.error && (
          <div className="mt-4">
            <ErrorState error={setStatus.error} />
          </div>
        )}
      </div>
    </>
  );
};

const LoginPage = () => {
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in');
  const [signInEmail, setSignInEmail] = useState('');
  const [signInError, setSignInError] = useState<null | string>(null);
  const [signInPassword, setSignInPassword] = useState('');
  const [signInPending, setSignInPending] = useState(false);
  const [registration, dispatch] = useReducer(
    registrationReducer,
    undefined,
    initialRegistrationState,
  );
  // Synchronous guard so a fast double submit cannot start a second
  // request before the reducer's busy flag has re-rendered.
  const registrationBusy = useRef(false);

  const releaseRegistration = () => {
    registrationBusy.current = false;
  };

  const { busy: pending, error, fields, step } = registration;

  const startRegistration = () => {
    setMode('sign-up');
    dispatch({ type: 'begin-registration' });
  };

  const backToSignIn = () => {
    setMode('sign-in');
  };

  const submitSignIn = async (event: React.FormEvent) => {
    event.preventDefault();
    setSignInError(null);
    setSignInPending(true);
    const result = await signIn.email({
      email: signInEmail,
      password: signInPassword,
    });
    setSignInPending(false);
    if (result.error) {
      setSignInError(result.error.message ?? 'Authentication failed.');
    }
  };

  const submitTokenStep = async (event: React.FormEvent) => {
    event.preventDefault();
    if (registrationBusy.current) {
      return;
    }

    registrationBusy.current = true;
    dispatch({ type: 'token-submit' });
    try {
      const response = await quietFetch('/api/invites/validate', {
        body: JSON.stringify({ token: fields.inviteToken.trim() }),
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        method: 'POST',
      });
      dispatch({ ok: response.ok, type: 'token-result' });
    } catch {
      dispatch({ ok: false, type: 'token-result' });
    } finally {
      releaseRegistration();
    }
  };

  const submitDetailsStep = async (event: React.FormEvent) => {
    event.preventDefault();
    if (registrationBusy.current) {
      return;
    }

    registrationBusy.current = true;
    dispatch({ type: 'details-submit' });
    const result = await signUp.email({
      email: fields.email,
      fetchOptions: {
        headers: { 'X-Setup-Token': fields.inviteToken.trim() },
      },
      name: fields.name,
      password: fields.password,
    });
    dispatch({
      error: (result.error ?? null) as null | SignUpFailure,
      type: 'details-result',
    });
    releaseRegistration();
  };

  return (
    <div className="grid min-h-screen place-items-center bg-slate-950 p-4 text-slate-100">
      <div className="w-full max-w-sm rounded-xl border border-slate-800 bg-slate-900/70 p-6">
        <div className="mb-6 flex items-center gap-2 text-sm font-bold tracking-tight text-white">
          <span className="grid size-7 place-items-center rounded-md bg-cyan-400 text-slate-950">
            <PanelsTopLeft size={16} />
          </span>
          Lead Desk
        </div>
        {mode === 'sign-in' ? (
          <form
            className="grid gap-4"
            onSubmit={submitSignIn}
          >
            <label className="grid gap-1 text-sm text-slate-300">
              Email
              <input
                onChange={(event) => {
                  setSignInEmail(event.target.value);
                }}
                placeholder="you@example.com"
                required
                type="email"
                value={signInEmail}
              />
            </label>
            <label className="grid gap-1 text-sm text-slate-300">
              Password
              <input
                minLength={8}
                onChange={(event) => {
                  setSignInPassword(event.target.value);
                }}
                required
                type="password"
                value={signInPassword}
              />
            </label>
            {signInError && (
              <p
                className="rounded-md border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-100"
                role="alert"
              >
                {signInError}
              </p>
            )}
            <Button
              disabled={signInPending}
              type="submit"
            >
              Sign in
            </Button>
          </form>
        ) : step === 1 ? (
          <form
            className="grid gap-4"
            onSubmit={submitTokenStep}
          >
            <label className="grid gap-1 text-sm text-slate-300">
              Invite token
              <input
                onChange={(event) => {
                  dispatch({
                    name: 'inviteToken',
                    type: 'field-change',
                    value: event.target.value,
                  });
                }}
                placeholder="Shared with you by a staff member"
                required
                value={fields.inviteToken}
              />
            </label>
            {error && (
              <p
                className="rounded-md border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-100"
                role="alert"
              >
                {error}
              </p>
            )}
            <Button
              disabled={pending}
              type="submit"
            >
              Continue
            </Button>
          </form>
        ) : (
          <form
            className="grid gap-4"
            onSubmit={submitDetailsStep}
          >
            <label className="grid gap-1 text-sm text-slate-300">
              Name
              <input
                onChange={(event) => {
                  dispatch({
                    name: 'name',
                    type: 'field-change',
                    value: event.target.value,
                  });
                }}
                placeholder="Ada Lovelace"
                required
                value={fields.name}
              />
            </label>
            <label className="grid gap-1 text-sm text-slate-300">
              Email
              <input
                onChange={(event) => {
                  dispatch({
                    name: 'email',
                    type: 'field-change',
                    value: event.target.value,
                  });
                }}
                placeholder="you@example.com"
                required
                type="email"
                value={fields.email}
              />
            </label>
            <label className="grid gap-1 text-sm text-slate-300">
              Password
              <input
                minLength={8}
                onChange={(event) => {
                  dispatch({
                    name: 'password',
                    type: 'field-change',
                    value: event.target.value,
                  });
                }}
                required
                type="password"
                value={fields.password}
              />
            </label>
            {error && (
              <p
                className="rounded-md border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-100"
                role="alert"
              >
                {error}
              </p>
            )}
            <Button
              disabled={pending}
              onClick={() => dispatch({ type: 'back-to-token' })}
              tone="secondary"
              type="button"
            >
              Back
            </Button>
            <Button
              disabled={pending}
              type="submit"
            >
              Create account
            </Button>
          </form>
        )}
        {mode === 'sign-in' ? (
          <button
            className="mt-4 text-sm text-cyan-300 hover:text-cyan-200"
            onClick={startRegistration}
            type="button"
          >
            Create account
          </button>
        ) : step === 1 ? (
          <button
            className="mt-4 text-sm text-cyan-300 hover:text-cyan-200"
            disabled={pending}
            onClick={backToSignIn}
            type="button"
          >
            Sign in
          </button>
        ) : null}
      </div>
    </div>
  );
};

export const App = () => {
  const { data: session, isPending } = useSession();
  if (isPending) {
    return (
      <div className="grid min-h-screen place-items-center bg-slate-950 text-sm text-slate-400">
        Loading…
      </div>
    );
  }

  if (!session) {
    return <LoginPage />;
  }

  return (
    <Shell>
      <Switch>
        <Route path="/leads/:id">
          {(parameters) => <LeadDetailPage id={parameters.id} />}
        </Route>
        <Route path="/leads">
          <LeadsPage />
        </Route>
        <Route path="/settings/tokens">
          <TokensPage />
        </Route>
        <Route path="/settings/invites">
          <InvitesPage />
        </Route>
        <Route path="/settings/staff">
          <StaffPage />
        </Route>
        <Route>
          <LeadsPage />
        </Route>
      </Switch>
    </Shell>
  );
};
