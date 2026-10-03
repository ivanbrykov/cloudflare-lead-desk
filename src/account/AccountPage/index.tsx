import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Notice } from '@/components/Notice';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { inputClass } from '@/components/ui/form';
import { changePassword, updateUser, useSession } from '@/lib/auth-client';
import { request } from '@/lib/http';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';

type AccountSession = {
  createdAt: string;
  current: boolean;
  expiresAt: string;
  id: string;
  ipAddress: null | string;
  userAgent: null | string;
};

const sessionQuery = {
  queryFn: () => request<AccountSession[]>('/v1/account/sessions'),
  queryKey: ['account-sessions'],
};

const formatTimestamp = (value: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      });
};

const describeAgent = (userAgent: null | string): string => {
  if (!userAgent) {
    return 'Unknown device';
  }

  const browser = /Edg\//u.test(userAgent)
    ? 'Edge'
    : /OPR\//u.test(userAgent)
      ? 'Opera'
      : /Firefox\//u.test(userAgent)
        ? 'Firefox'
        : /Chrome\//u.test(userAgent)
          ? 'Chrome'
          : /Safari\//u.test(userAgent)
            ? 'Safari'
            : 'Unknown browser';

  const platform = /Windows/u.test(userAgent)
    ? 'Windows'
    : /Mac OS X/u.test(userAgent)
      ? 'macOS'
      : /Android/u.test(userAgent)
        ? 'Android'
        : /iPhone|iPad/u.test(userAgent)
          ? 'iOS'
          : /Linux/u.test(userAgent)
            ? 'Linux'
            : 'unknown platform';

  return `${browser} on ${platform}`;
};

const ProfileSection = ({ name }: { readonly name: string }) => {
  const { data: session, refetch } = useSession();
  const [draftName, setDraftName] = useState(name);
  const [formError, setFormError] = useState<null | string>(null);

  const save = useMutation({
    mutationFn: async (trimmedName: string) => {
      const { error } = await updateUser({ name: trimmedName });
      if (error) {
        throw new Error(error.message ?? 'The name could not be saved.');
      }
    },
    onSuccess: async () => {
      setFormError(null);
      toast.success('Name updated');
      await refetch();
    },
  });

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmedName = draftName.trim();
    if (trimmedName === name) {
      setFormError(null);
      return;
    }

    if (trimmedName === '') {
      setFormError('Enter a name.');
      return;
    }

    if (trimmedName.length > 200) {
      setFormError('Name must be at most 200 characters.');
      return;
    }

    save.mutate(trimmedName);
  };

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">
        Profile
      </h2>
      <p className="mt-1 text-xs text-slate-500">
        Your display name appears on notes and activity history.
      </p>
      <form
        className="mt-4 grid gap-4"
        onSubmit={submit}
      >
        <Field
          hint="1–200 characters"
          label="Name"
        >
          <input
            className={inputClass}
            maxLength={200}
            onChange={(event) => {
              setDraftName(event.target.value);
            }}
            required
            value={draftName}
          />
        </Field>
        <Field
          hint="Contact an administrator to change the email address."
          label="Email"
        >
          <input
            className={`${inputClass} cursor-not-allowed opacity-60`}
            disabled
            readOnly
            value={session?.user?.email ?? ''}
          />
        </Field>
        {formError && <p className="text-sm text-rose-300">{formError}</p>}
        {save.error && <Notice error={save.error} />}
        <div>
          <Button
            disabled={save.isPending || draftName.trim() === name}
            type="submit"
          >
            Save name
          </Button>
        </div>
      </form>
    </section>
  );
};

const PasswordSection = () => {
  const queryClient = useQueryClient();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [formError, setFormError] = useState<null | string>(null);

  const rotate = useMutation({
    mutationFn: async (input: {
      currentPassword: string;
      newPassword: string;
    }) => {
      const { error } = await changePassword(input);
      if (error) {
        throw new Error(error.message ?? 'The password could not be changed.');
      }
    },
    onSuccess: () => {
      setCurrentPassword('');
      setNewPassword('');
      setConfirmation('');
      setFormError(null);
      toast.success('Password changed');
      toast.info('Other devices were signed out');
      void queryClient.invalidateQueries({ queryKey: sessionQuery.queryKey });
    },
  });

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (newPassword !== confirmation) {
      setFormError('The new passwords do not match.');
      return;
    }

    if (newPassword.length < 8) {
      setFormError('The new password must be at least 8 characters.');
      return;
    }

    setFormError(null);
    rotate.mutate({ currentPassword, newPassword });
  };

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-5">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">
        Password
      </h2>
      <p className="mt-1 text-xs text-slate-500">
        Changing the password signs out every other device.
      </p>
      <form
        className="mt-4 grid gap-4"
        onSubmit={submit}
      >
        <Field label="Current password">
          <input
            className={inputClass}
            minLength={8}
            onChange={(event) => {
              setCurrentPassword(event.target.value);
            }}
            required
            type="password"
            value={currentPassword}
          />
        </Field>
        <Field
          hint="At least 8 characters"
          label="New password"
        >
          <input
            className={inputClass}
            minLength={8}
            onChange={(event) => {
              setNewPassword(event.target.value);
            }}
            required
            type="password"
            value={newPassword}
          />
        </Field>
        <Field label="Confirm new password">
          <input
            className={inputClass}
            minLength={8}
            onChange={(event) => {
              setConfirmation(event.target.value);
            }}
            required
            type="password"
            value={confirmation}
          />
        </Field>
        {formError && <p className="text-sm text-rose-300">{formError}</p>}
        {rotate.error && <Notice error={rotate.error} />}
        <div>
          <Button
            disabled={
              rotate.isPending ||
              currentPassword === '' ||
              newPassword === '' ||
              confirmation === ''
            }
            type="submit"
          >
            Change password
          </Button>
        </div>
      </form>
    </section>
  );
};

const SessionsSection = () => {
  const queryClient = useQueryClient();
  const [confirmRevokeAll, setConfirmRevokeAll] = useState(false);
  const [pendingRevokeId, setPendingRevokeId] = useState<null | string>(null);
  const sessions = useQuery(sessionQuery);

  const revokeOne = useMutation({
    mutationFn: (id: string) =>
      request<undefined>(`/v1/account/sessions/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Session revoked');
      void queryClient.invalidateQueries({ queryKey: sessionQuery.queryKey });
    },
  });

  const revokeOthers = useMutation({
    mutationFn: () =>
      request<{ revoked: number }>('/v1/account/sessions/revoke-others', {
        method: 'POST',
      }),
    onSuccess: (result) => {
      toast.success(
        result.revoked === 1
          ? 'Signed out 1 other device'
          : `Signed out ${result.revoked} other devices`,
      );
      void queryClient.invalidateQueries({ queryKey: sessionQuery.queryKey });
    },
  });

  const rows = sessions.data ?? [];
  const otherCount = rows.filter((row) => !row.current).length;

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">
          Sessions
        </h2>
        {otherCount > 0 && (
          <Button
            onClick={() => {
              setConfirmRevokeAll(true);
            }}
            tone="secondary"
          >
            Sign out other devices ({otherCount})
          </Button>
        )}
      </div>
      <p className="mt-1 text-xs text-slate-500">
        Devices currently signed in to this account.
      </p>
      {sessions.isPending ? (
        <p className="mt-4 text-sm text-slate-400">Loading sessions…</p>
      ) : sessions.error ? (
        <div className="mt-4">
          <Notice error={sessions.error} />
        </div>
      ) : rows.length === 0 ? (
        <p className="mt-4 text-sm text-slate-400">No active sessions.</p>
      ) : (
        <ul className="mt-4 grid gap-2">
          {rows.map((row) => (
            <li
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-950/60 px-4 py-3"
              key={row.id}
            >
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-sm font-medium text-slate-100">
                  {describeAgent(row.userAgent)}
                  {row.current && (
                    <span className="rounded bg-cyan-400/15 px-1.5 py-0.5 text-xs font-semibold text-cyan-300">
                      This device
                    </span>
                  )}
                </p>
                <p className="mt-0.5 truncate text-xs text-slate-500">
                  {row.ipAddress ?? 'unknown IP'} · signed in{' '}
                  {formatTimestamp(row.createdAt)} · expires{' '}
                  {formatTimestamp(row.expiresAt)}
                </p>
              </div>
              {!row.current && (
                <Button
                  disabled={revokeOne.isPending && pendingRevokeId === row.id}
                  onClick={() => {
                    setPendingRevokeId(row.id);
                    revokeOne.mutate(row.id);
                  }}
                  tone="secondary"
                >
                  Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {revokeOne.error && (
        <div className="mt-4">
          <Notice error={revokeOne.error} />
        </div>
      )}
      {revokeOthers.error && (
        <div className="mt-4">
          <Notice error={revokeOthers.error} />
        </div>
      )}
      <ConfirmDialog
        confirmLabel="Sign out"
        description={`Sign out ${otherCount} ${
          otherCount === 1 ? 'device' : 'devices'
        }? They will need the password to sign in again.`}
        onConfirm={() => {
          setConfirmRevokeAll(false);
          revokeOthers.mutate();
        }}
        onOpenChange={setConfirmRevokeAll}
        open={confirmRevokeAll}
        pending={revokeOthers.isPending}
        title="Sign out other devices"
      />
    </section>
  );
};

export const AccountPage = () => {
  const { data: session } = useSession();
  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title="Account"
      />
      <div className="grid gap-6 p-5 sm:p-8">
        <ProfileSection name={session?.user?.name ?? ''} />
        <PasswordSection />
        <SessionsSection />
      </div>
    </>
  );
};
