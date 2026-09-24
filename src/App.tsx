import { Button } from './components/ui/button';
import { Dialog } from './components/ui/dialog';
import {
  type ContactInput,
  ContactInputSchema,
  type CreateCustomField,
  CreateCustomFieldSchema,
} from './domain/schemas';
import {
  authClient,
  signIn,
  signOut,
  signUp,
  useSession,
} from './lib/auth-client';
import {
  customFieldsForCreate,
  customFieldsForUpdate,
  isBlankCustomFieldValue,
} from './lib/custom-field-form';
import { ApiClientError, request } from './lib/http';
import { quietFetch } from './lib/quiet-fetch';
import {
  initialRegistrationState,
  registrationReducer,
  type SignUpFailure,
} from './lib/registration-flow';
import { cn } from './lib/styles';
import {
  DndContext,
  type DragEndEvent,
  useDraggable,
  useDroppable,
} from '@dnd-kit/core';
import { effectTsResolver } from '@hookform/resolvers/effect-ts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ContactRound,
  Copy,
  KeyRound,
  LayoutList,
  LogOut,
  Mail,
  PanelsTopLeft,
  Plus,
  Settings2,
  SlidersHorizontal,
  Users,
} from 'lucide-react';
import { useEffect, useReducer, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, Route, Switch, useLocation } from 'wouter';

type Contact = {
  createdAt: string;
  customFields: Record<string, unknown>;
  email: null | string;
  firstName: null | string;
  id: string;
  lastName: null | string;
};

type FieldDefinition = {
  entityType: 'contact' | 'opportunity';
  id: string;
  key: string;
  label: string;
  options: string[];
  required: boolean;
  type: 'boolean' | 'date' | 'number' | 'select' | 'text';
};

type Invite = {
  createdAt: string;
  expiresAt: null | string;
  id: string;
  name: string;
  prefix: string;
  revokedAt: null | string;
  usedAt: null | string;
};

type Opportunity = {
  contact: Contact;
  createdAt: string;
  customFields: Record<string, unknown>;
  estimatedValue: null | number;
  id: string;
  name: string;
  pipelineId: string;
  source: string;
  stageId: string;
};

type Pipeline = {
  archivedAt: null | string;
  id: string;
  name: string;
  stages: Stage[];
};
type StaffAccount = {
  disabledAt: null | string;
  email: string;
  id: string;
  name: string;
};

type Stage = { color: string; id: string; name: string; position: number };

type Token = {
  createdAt: string;
  expiresAt: null | string;
  id: string;
  name: string;
  prefix: string;
  revokedAt: null | string;
};

const navigation = [
  { href: '/opportunities', icon: LayoutList, label: 'Opportunities' },
  { href: '/contacts', icon: ContactRound, label: 'Contacts' },
  { href: '/settings/fields', icon: SlidersHorizontal, label: 'Fields' },
  { href: '/settings/invites', icon: Mail, label: 'Invitations' },
  { href: '/settings/staff', icon: Users, label: 'Staff' },
  { href: '/settings/tokens', icon: KeyRound, label: 'Tokens' },
];

const appQuery = {
  contacts: () => ({
    queryFn: () => request<Contact[]>('/v1/contacts'),
    queryKey: ['contacts'],
  }),
  invites: () => ({
    queryFn: () => request<Invite[]>('/v1/invites'),
    queryKey: ['invites'],
  }),
  // The board fetches opportunities filtered by the selected pipeline. The
  // pipeline id is part of the query key so every board selection has its
  // own cached list, while `invalidateQueries({ queryKey: ['opportunities'] })`
  // still refreshes all of them.
  opportunities: (pipelineId?: string) => ({
    queryFn: () =>
      request<Opportunity[]>(
        pipelineId
          ? `/v1/opportunities?pipelineId=${pipelineId}`
          : '/v1/opportunities',
      ),
    queryKey: ['opportunities', pipelineId ?? null],
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

const retryWorkQueueQuery = (failureCount: number, error: Error) => {
  if (error instanceof ApiClientError) {
    if (error.status === 401) {
      return failureCount < 2;
    }

    return error.status >= 500 && failureCount < 3;
  }

  return failureCount < 3;
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

const emptyToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim().length === 0 ? undefined : value;

const InlineFieldError = ({
  error,
  message,
}: {
  readonly error?: unknown;
  readonly message: string;
}) => (error ? <p className="mt-1 text-sm text-rose-300">{message}</p> : null);

const validateRequiredCustomFields = (
  definitions: FieldDefinition[],
  values: Record<string, unknown>,
): Record<string, string> =>
  Object.fromEntries(
    definitions
      .filter(
        (field) => field.required && isBlankCustomFieldValue(values[field.key]),
      )
      .map((field) => [field.key, field.label + ' is required.']),
  );

const CustomFieldInputs = ({
  definitions,
  errors,
  onChange,
  values,
}: {
  readonly definitions: FieldDefinition[];
  readonly errors: Record<string, string>;
  readonly onChange: (key: string, value: unknown) => void;
  readonly values: Record<string, unknown>;
}) => {
  if (definitions.length === 0) {
    return null;
  }

  return (
    <fieldset className="grid gap-3 border-t border-slate-800 pt-4">
      <legend className="px-0 text-sm font-medium text-slate-200">
        Custom fields
      </legend>
      {definitions.map((field) => {
        const error = errors[field.key];
        const label = (
          <span>
            {field.label}
            {field.required && <span className="ml-1 text-rose-300">*</span>}
          </span>
        );
        if (field.type === 'boolean') {
          return (
            <label
              className="grid gap-1 text-sm text-slate-300"
              key={field.id}
            >
              {label}
              <span className="flex gap-2">
                <input
                  checked={Boolean(values[field.key])}
                  onChange={(event) =>
                    onChange(field.key, event.target.checked)
                  }
                  type="checkbox"
                />{' '}
                Yes
              </span>
              {error && <p className="text-sm text-rose-300">{error}</p>}
            </label>
          );
        }

        if (field.type === 'select') {
          return (
            <label
              className="grid gap-1 text-sm text-slate-300"
              key={field.id}
            >
              {label}
              <select
                onChange={(event) =>
                  onChange(
                    field.key,
                    event.target.value === '' ? null : event.target.value,
                  )
                }
                value={String(values[field.key] ?? '')}
              >
                <option value="">Choose an option…</option>
                {field.options.map((option) => (
                  <option
                    key={option}
                    value={option}
                  >
                    {option}
                  </option>
                ))}
              </select>
              {error && <p className="text-sm text-rose-300">{error}</p>}
            </label>
          );
        }

        return (
          <label
            className="grid gap-1 text-sm text-slate-300"
            key={field.id}
          >
            {label}
            <input
              onChange={(event) =>
                onChange(
                  field.key,
                  field.type === 'number'
                    ? event.target.value === ''
                      ? null
                      : Number(event.target.value)
                    : event.target.value === ''
                      ? null
                      : event.target.value,
                )
              }
              type={
                field.type === 'date'
                  ? 'date'
                  : field.type === 'number'
                    ? 'number'
                    : 'text'
              }
              value={String(values[field.key] ?? '')}
            />
            {error && <p className="text-sm text-rose-300">{error}</p>}
          </label>
        );
      })}
    </fieldset>
  );
};

const Shell = ({ children }: { readonly children: React.ReactNode }) => {
  const [location] = useLocation();
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 lg:grid lg:grid-cols-[14rem_1fr]">
      <aside className="border-b border-slate-800 bg-slate-900/70 p-4 lg:min-h-screen lg:border-b-0 lg:border-r">
        <Link
          className="mb-8 flex items-center gap-2 px-2 text-sm font-bold tracking-tight text-white"
          href="/opportunities"
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

const contactFormValues = (contact?: Contact | null): ContactInput => ({
  email: contact?.email ?? undefined,
  firstName: contact?.firstName ?? undefined,
  lastName: contact?.lastName ?? undefined,
});

const normalizeContactInput = (input: ContactInput): ContactInput => ({
  email: input.email?.trim() || undefined,
  firstName: input.firstName?.trim() || undefined,
  lastName: input.lastName?.trim() || undefined,
});

const ContactDialog = ({
  contact,
  onOpenChange,
  open,
}: {
  readonly contact?: Contact | null;
  readonly onOpenChange: (value: boolean) => void;
  readonly open: boolean;
}) => {
  const queryClient = useQueryClient();
  const fieldDefinitions = useQuery({
    queryFn: () =>
      request<FieldDefinition[]>('/v1/custom-fields?entityType=contact'),
    queryKey: ['fields', 'contact'],
  });
  const [customFields, setCustomFields] = useState<Record<string, unknown>>({});
  const [customFieldErrors, setCustomFieldErrors] = useState<
    Record<string, string>
  >({});
  const form = useForm<ContactInput>({
    defaultValues: contactFormValues(contact),
    resolver: effectTsResolver(ContactInputSchema),
  });
  // Reset field state when the dialog opens for a different contact (or
  // reopens). Adjusting state during render, as in the React docs, re-renders
  // immediately, so the previous contact's values never flash on screen
  const [resetKey, setResetKey] = useState<null | string>(null);
  const dialogKey = open ? (contact?.id ?? 'new') : null;

  if (dialogKey === null) {
    if (resetKey !== null) {
      setResetKey(null);
    }
  } else if (resetKey !== dialogKey) {
    setResetKey(dialogKey);
    setCustomFields(contact?.customFields ?? {});
    setCustomFieldErrors({});
  }

  // form.reset is an imperative call, not React state, so it stays in an
  // effect rather than the render-phase state adjustment above
  useEffect(() => {
    if (!open) {
      return;
    }

    form.reset(contactFormValues(contact));
  }, [contact, form, open]);

  const mutation = useMutation({
    mutationFn: (input: ContactInput) =>
      request<Contact>(
        contact ? '/v1/contacts/' + contact.id : '/v1/contacts',
        {
          body: JSON.stringify(input),
          method: contact ? 'PUT' : 'POST',
        },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
      onOpenChange(false);
    },
  });
  const editing = Boolean(contact);
  const submit = async (values: ContactInput) => {
    // A field may have been archived in another tab since this contact loaded.
    // Fetch current definitions before shaping the edit payload.
    const definitions = await fieldDefinitions.refetch();
    if (definitions.isError || !definitions.data) {
      return;
    }

    const errors = validateRequiredCustomFields(definitions.data, customFields);
    setCustomFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      return;
    }

    const input = normalizeContactInput(values);
    if (!input.email && !input.firstName && !input.lastName) {
      form.setError('firstName', { message: 'identity_required' });
      return;
    }

    mutation.mutate({
      ...input,
      customFields: editing
        ? customFieldsForUpdate(customFields, definitions.data)
        : customFieldsForCreate(customFields),
    });
  };

  return (
    <Dialog
      onOpenChange={onOpenChange}
      open={open}
      title={editing ? 'Edit contact' : 'New contact'}
    >
      <form
        className="grid gap-4"
        onSubmit={form.handleSubmit(submit)}
      >
        <label className="grid gap-1 text-sm text-slate-300">
          First name
          <input
            {...form.register('firstName', { setValueAs: emptyToUndefined })}
            placeholder="Sam"
          />
          <InlineFieldError
            error={form.formState.errors.firstName}
            message="Enter a first name, last name, or email address."
          />
        </label>
        <label className="grid gap-1 text-sm text-slate-300">
          Last name
          <input
            {...form.register('lastName', { setValueAs: emptyToUndefined })}
            placeholder="Morgan"
          />
          <InlineFieldError
            error={form.formState.errors.lastName}
            message="Enter a last name or leave this optional field blank."
          />
        </label>
        <label className="grid gap-1 text-sm text-slate-300">
          Email
          <input
            {...form.register('email', { setValueAs: emptyToUndefined })}
            placeholder="alex@example.com"
            type="email"
          />
          <InlineFieldError
            error={form.formState.errors.email}
            message="Enter a valid email address."
          />
        </label>
        {fieldDefinitions.isPending ? (
          <p className="text-sm text-slate-400">Loading custom fields…</p>
        ) : (
          <CustomFieldInputs
            definitions={fieldDefinitions.data ?? []}
            errors={customFieldErrors}
            onChange={(key, value) =>
              setCustomFields((current) => ({ ...current, [key]: value }))
            }
            values={customFields}
          />
        )}
        {fieldDefinitions.error && (
          <ErrorState error={fieldDefinitions.error} />
        )}
        {mutation.error && <ErrorState error={mutation.error} />}
        <div className="flex justify-end gap-2">
          <Button
            onClick={() => onOpenChange(false)}
            tone="secondary"
          >
            Cancel
          </Button>
          <Button
            disabled={
              mutation.isPending ||
              form.formState.isSubmitting ||
              fieldDefinitions.isPending
            }
            type="submit"
          >
            {editing ? 'Save changes' : 'Create contact'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
};

type ManualOpportunityForm = {
  contactId: string;
  contactMode: 'existing' | 'new';
  email: string;
  estimatedValue: string;
  firstName: string;
  lastName: string;
  name: string;
  pipelineId: string;
  source: string;
  stageId: string;
};

const OpportunityDialog = ({
  onOpenChange,
  open,
}: {
  readonly onOpenChange: (value: boolean) => void;
  readonly open: boolean;
}) => {
  const queryClient = useQueryClient();
  const contacts = useQuery(appQuery.contacts());
  const pipelines = useQuery(appQuery.pipelines());
  const contactFieldDefinitions = useQuery({
    queryFn: () =>
      request<FieldDefinition[]>('/v1/custom-fields?entityType=contact'),
    queryKey: ['fields', 'contact'],
  });
  const opportunityFieldDefinitions = useQuery({
    queryFn: () =>
      request<FieldDefinition[]>('/v1/custom-fields?entityType=opportunity'),
    queryKey: ['fields', 'opportunity'],
  });
  const [contactCustomFields, setContactCustomFields] = useState<
    Record<string, unknown>
  >({});
  const [opportunityCustomFields, setOpportunityCustomFields] = useState<
    Record<string, unknown>
  >({});
  const [contactCustomErrors, setContactCustomErrors] = useState<
    Record<string, string>
  >({});
  const [opportunityCustomErrors, setOpportunityCustomErrors] = useState<
    Record<string, string>
  >({});
  const form = useForm<ManualOpportunityForm>({
    defaultValues: {
      contactId: '',
      contactMode: 'existing',
      email: '',
      estimatedValue: '',
      firstName: '',
      lastName: '',
      name: '',
      pipelineId: '',
      source: 'Manual entry',
      stageId: '',
    },
  });
  const availablePipelines = (pipelines.data ?? []).filter(
    (pipeline) => pipeline.stages.length > 0,
  );
  const pipelineId = form.watch('pipelineId');
  const selectedPipeline = availablePipelines.find(
    (pipeline) => pipeline.id === pipelineId,
  );
  useEffect(() => {
    if (!open) {
      return;
    }

    const pipeline = (pipelines.data ?? []).find(
      (item) => item.stages.length > 0,
    );
    form.reset({
      contactId: '',
      contactMode: 'existing',
      email: '',
      estimatedValue: '',
      firstName: '',
      lastName: '',
      name: '',
      pipelineId: pipeline?.id ?? '',
      source: 'Manual entry',
      stageId: pipeline?.stages[0]?.id ?? '',
    });
    setContactCustomFields({});
    setOpportunityCustomFields({});
    setContactCustomErrors({});
    setOpportunityCustomErrors({});
  }, [form, open, pipelines.data]);
  const mutation = useMutation({
    mutationFn: async (values: ManualOpportunityForm) => {
      const body = {
        ...(values.contactMode === 'existing'
          ? { contactId: values.contactId }
          : {
              contact: {
                ...normalizeContactInput({
                  email: values.email,
                  firstName: values.firstName,
                  lastName: values.lastName,
                }),
                customFields: customFieldsForCreate(contactCustomFields),
              },
            }),
        customFields: customFieldsForCreate(opportunityCustomFields),
        estimatedValue: values.estimatedValue
          ? Number(values.estimatedValue)
          : undefined,
        name: values.name.trim(),
        pipelineId: values.pipelineId,
        source: values.source.trim() || undefined,
        stageId: values.stageId,
      };
      return request<Opportunity>('/v1/opportunities', {
        body: JSON.stringify(body),
        method: 'POST',
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
      queryClient.invalidateQueries({ queryKey: ['opportunities'] });
      onOpenChange(false);
    },
  });
  const contactMode = form.watch('contactMode');
  const submit = (values: ManualOpportunityForm) => {
    const nextContactErrors =
      values.contactMode === 'new'
        ? validateRequiredCustomFields(
            contactFieldDefinitions.data ?? [],
            contactCustomFields,
          )
        : {};
    const nextOpportunityErrors = validateRequiredCustomFields(
      opportunityFieldDefinitions.data ?? [],
      opportunityCustomFields,
    );
    setContactCustomErrors(nextContactErrors);
    setOpportunityCustomErrors(nextOpportunityErrors);
    if (
      Object.keys(nextContactErrors).length > 0 ||
      Object.keys(nextOpportunityErrors).length > 0
    ) {
      return;
    }

    mutation.mutate(values);
  };

  return (
    <Dialog
      onOpenChange={onOpenChange}
      open={open}
      title="New opportunity"
    >
      <form
        className="grid gap-4"
        onSubmit={form.handleSubmit(submit)}
      >
        <label className="grid gap-1 text-sm text-slate-300">
          Opportunity name
          <input
            {...form.register('name')}
            placeholder="New service inquiry"
            required
          />
        </label>
        <label className="grid gap-1 text-sm text-slate-300">
          Contact
          <select {...form.register('contactMode')}>
            <option value="existing">Select an existing contact</option>
            <option value="new">Create a new contact</option>
          </select>
        </label>
        {contactMode === 'existing' ? (
          <label className="grid gap-1 text-sm text-slate-300">
            Existing contact
            <select
              {...form.register('contactId')}
              required
            >
              <option value="">Choose a contact…</option>
              {contacts.data?.map((contact) => (
                <option
                  key={contact.id}
                  value={contact.id}
                >
                  {[contact.firstName, contact.lastName]
                    .filter(Boolean)
                    .join(' ') ||
                    contact.email ||
                    'Unnamed contact'}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <div className="grid gap-3 rounded-lg border border-slate-800 bg-slate-950/50 p-3">
            <p className="text-sm font-medium text-slate-200">New contact</p>
            <label className="grid gap-1 text-sm text-slate-300">
              First name
              <input
                {...form.register('firstName')}
                placeholder="Sam"
              />
            </label>
            <label className="grid gap-1 text-sm text-slate-300">
              Last name
              <input
                {...form.register('lastName')}
                placeholder="Morgan"
              />
            </label>
            <label className="grid gap-1 text-sm text-slate-300">
              Email
              <input
                {...form.register('email')}
                placeholder="alex@example.com"
                type="email"
              />
            </label>
            {contactFieldDefinitions.isPending ? (
              <p className="text-sm text-slate-400">Loading custom fields…</p>
            ) : (
              <CustomFieldInputs
                definitions={contactFieldDefinitions.data ?? []}
                errors={contactCustomErrors}
                onChange={(key, value) =>
                  setContactCustomFields((current) => ({
                    ...current,
                    [key]: value,
                  }))
                }
                values={contactCustomFields}
              />
            )}
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1 text-sm text-slate-300">
            Pipeline
            <select
              {...form.register('pipelineId')}
              onChange={(event) => {
                const next = availablePipelines.find(
                  (pipeline) => pipeline.id === event.target.value,
                );
                form.setValue('pipelineId', event.target.value);
                form.setValue('stageId', next?.stages[0]?.id ?? '');
              }}
              required
            >
              <option value="">Choose a pipeline…</option>
              {availablePipelines.map((pipeline) => (
                <option
                  key={pipeline.id}
                  value={pipeline.id}
                >
                  {pipeline.name}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm text-slate-300">
            Stage
            <select
              {...form.register('stageId')}
              required
            >
              <option value="">Choose a stage…</option>
              {selectedPipeline?.stages.map((stage) => (
                <option
                  key={stage.id}
                  value={stage.id}
                >
                  {stage.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1 text-sm text-slate-300">
            Source
            <input
              {...form.register('source')}
              placeholder="Manual entry"
            />
          </label>
          <label className="grid gap-1 text-sm text-slate-300">
            Estimated value
            <input
              {...form.register('estimatedValue')}
              min="0"
              placeholder="5000"
              type="number"
            />
          </label>
        </div>
        {opportunityFieldDefinitions.isPending ? (
          <p className="text-sm text-slate-400">Loading custom fields…</p>
        ) : (
          <CustomFieldInputs
            definitions={opportunityFieldDefinitions.data ?? []}
            errors={opportunityCustomErrors}
            onChange={(key, value) =>
              setOpportunityCustomFields((current) => ({
                ...current,
                [key]: value,
              }))
            }
            values={opportunityCustomFields}
          />
        )}
        {contactFieldDefinitions.error && (
          <ErrorState error={contactFieldDefinitions.error} />
        )}
        {opportunityFieldDefinitions.error && (
          <ErrorState error={opportunityFieldDefinitions.error} />
        )}
        {mutation.error && <ErrorState error={mutation.error} />}
        <div className="flex justify-end gap-2">
          <Button
            onClick={() => onOpenChange(false)}
            tone="secondary"
          >
            Cancel
          </Button>
          <Button
            disabled={
              mutation.isPending ||
              contacts.isPending ||
              pipelines.isPending ||
              contactFieldDefinitions.isPending ||
              opportunityFieldDefinitions.isPending ||
              !selectedPipeline
            }
            type="submit"
          >
            Create opportunity
          </Button>
        </div>
      </form>
    </Dialog>
  );
};

const OpportunityCard = ({
  opportunity,
}: {
  readonly opportunity: Opportunity;
}) => {
  const { attributes, listeners, setNodeRef, transform } = useDraggable({
    id: opportunity.id,
  });
  return (
    <Link
      href={`/opportunities/${opportunity.id}`}
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className="block cursor-grab rounded-md border border-slate-800 bg-slate-950 p-3 shadow-sm hover:border-slate-600 active:cursor-grabbing"
      style={
        transform
          ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
          : undefined
      }
    >
      <p className="text-sm font-semibold text-slate-100">{opportunity.name}</p>
      <p className="mt-1 text-xs text-slate-400">
        {[opportunity.contact.firstName, opportunity.contact.lastName]
          .filter(Boolean)
          .join(' ') || opportunity.contact.email}
      </p>
      <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
        <span>{opportunity.source}</span>
        <code className="font-mono text-[0.68rem] text-slate-600">
          {opportunity.id}
        </code>
        {opportunity.estimatedValue !== null && (
          <span>${opportunity.estimatedValue.toLocaleString()}</span>
        )}
      </div>
    </Link>
  );
};

const StageColumn = ({
  opportunities,
  stage,
}: {
  readonly opportunities: Opportunity[];
  readonly stage: Stage;
}) => {
  const { isOver, setNodeRef } = useDroppable({ id: stage.id });
  return (
    <section
      className={cn(
        'min-h-56 rounded-lg border p-3 transition',
        isOver
          ? 'border-cyan-400 bg-cyan-400/5'
          : 'border-slate-800 bg-slate-900/40',
      )}
      ref={setNodeRef}
    >
      <div className="mb-3 flex items-center justify-between">
        <span className="text-sm font-semibold text-slate-200">
          {stage.name}
        </span>
        <span className="rounded-full bg-slate-800 px-2 py-0.5 text-xs text-slate-400">
          {opportunities.length}
        </span>
      </div>
      <div className="grid gap-2">
        {opportunities.map((opportunity) => (
          <OpportunityCard
            key={opportunity.id}
            opportunity={opportunity}
          />
        ))}
      </div>
    </section>
  );
};

const OpportunitiesPage = () => {
  const { refetch: refetchSession } = useSession();
  // Keep automatic recovery bounded when a server keeps returning 401.
  const recoveredPipelineId = useRef<null | string>(null);
  const [selectedPipelineId, setSelectedPipelineId] = useState<null | string>(
    null,
  );
  const [showOpportunity, setShowOpportunity] = useState(false);
  const queryClient = useQueryClient();
  const pipelines = useQuery({
    ...appQuery.pipelines(),
    retry: retryWorkQueueQuery,
  });
  // Only active pipelines can be listed (the API rejects archived ids), so
  // archived pipelines never appear as options.
  const activePipelines = (pipelines.data ?? []).filter(
    (item) => item.archivedAt === null,
  );
  // Default selection: the first non-archived pipeline with stages, which
  // matches the previous "first pipeline" board behavior. An explicit user
  // selection stays sticky until it changes.
  const defaultPipelineId =
    activePipelines.find((item) => item.stages.length > 0)?.id ??
    activePipelines[0]?.id;
  const pipelineId = selectedPipelineId ?? defaultPipelineId;
  const opportunities = useQuery({
    ...appQuery.opportunities(pipelineId),
    enabled: pipelineId !== undefined,
    retry: retryWorkQueueQuery,
  });
  const workQueueError = opportunities.error ?? pipelines.error;
  const hasUnauthorizedError = [opportunities.error, pipelines.error].some(
    (error) => error instanceof ApiClientError && error.status === 401,
  );
  useEffect(() => {
    if (!hasUnauthorizedError) {
      return undefined;
    }

    const recoveryKey = pipelineId ?? 'no-pipeline';
    if (recoveredPipelineId.current === recoveryKey) {
      return undefined;
    }

    recoveredPipelineId.current = recoveryKey;
    let cancelled = false;
    const recover = async () => {
      try {
        const result = await authClient.getSession();
        if (cancelled || result.error) {
          return;
        }

        if (!result.data) {
          refetchSession();
          return;
        }

        await queryClient.invalidateQueries({ queryKey: ['pipelines'] });
        if (pipelineId !== undefined) {
          await queryClient.invalidateQueries({
            exact: true,
            queryKey: ['opportunities', pipelineId],
          });
        }
      } catch {
        // The visible retry control remains available if the recheck fails.
      }
    };

    recover();

    return () => {
      cancelled = true;
    };
  }, [hasUnauthorizedError, pipelineId, queryClient, refetchSession]);
  useEffect(() => {
    if (
      pipelines.isSuccess &&
      (pipelineId === undefined || opportunities.isSuccess)
    ) {
      recoveredPipelineId.current = null;
    }
  }, [opportunities.isSuccess, pipelineId, pipelines.isSuccess]);
  const move = useMutation({
    mutationFn: ({
      opportunityId,
      stageId,
    }: {
      opportunityId: string;
      stageId: string;
    }) =>
      request<Opportunity>(`/v1/opportunities/${opportunityId}/move`, {
        body: JSON.stringify({ stageId }),
        method: 'POST',
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ['opportunities'] }),
  });
  const onDragEnd = (event: DragEndEvent) => {
    if (!event.over || event.active.id === event.over.id) {
      return;
    }

    move.mutate({
      opportunityId: String(event.active.id),
      stageId: String(event.over.id),
    });
  };

  const retryWorkQueue = () => {
    if (pipelines.error) {
      pipelines.refetch();
    }

    if (opportunities.error) {
      opportunities.refetch();
    }
  };

  const hasUsableBoard =
    pipelines.data !== undefined &&
    (pipelineId === undefined || opportunities.data !== undefined);

  if (workQueueError && !hasUsableBoard) {
    return (
      <div className="p-8">
        <ErrorState
          error={workQueueError}
          onRetry={retryWorkQueue}
        />
      </div>
    );
  }

  const pipeline = pipelineId
    ? activePipelines.find((item) => item.id === pipelineId)
    : undefined;
  const noPipelines = !pipelines.isPending && !pipeline;
  return (
    <>
      <Header
        action={
          <Button onClick={() => setShowOpportunity(true)}>
            <Plus size={16} /> Add opportunity
          </Button>
        }
        eyebrow="Work queue"
        title="Opportunities"
      />
      <div className="p-5 sm:p-8">
        {workQueueError && (
          <div className="mb-5">
            <ErrorState
              error={workQueueError}
              onRetry={retryWorkQueue}
            />
          </div>
        )}
        <div className="mb-5 flex flex-wrap items-center gap-3 rounded-lg border border-slate-800 bg-slate-900/40 p-3 text-sm text-slate-400">
          <Settings2 size={16} />
          <span>
            Drag an opportunity between stages to update its pipeline.
          </span>
          <label className="ml-auto grid gap-1 text-xs text-slate-500">
            <span>Pipeline</span>
            <select
              className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-slate-200"
              disabled={pipelines.isPending || activePipelines.length === 0}
              onChange={(event) => setSelectedPipelineId(event.target.value)}
              value={pipelineId ?? ''}
            >
              {activePipelines.length === 0 && (
                <option value="">No active pipelines</option>
              )}
              {activePipelines.map((item) => (
                <option
                  key={item.id}
                  value={item.id}
                >
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {noPipelines ? (
          <p className="text-slate-400">
            No active pipelines, so there is nothing to show.
          </p>
        ) : opportunities.isPending || pipelines.isPending ? (
          <p className="text-slate-400">Loading work queue…</p>
        ) : pipeline?.stages.length ? (
          <DndContext onDragEnd={onDragEnd}>
            <div className="grid gap-4 overflow-x-auto md:grid-cols-2 xl:grid-cols-3">
              {pipeline.stages.map((stage) => (
                <StageColumn
                  key={stage.id}
                  opportunities={(opportunities.data ?? []).filter(
                    (opportunity) => opportunity.stageId === stage.id,
                  )}
                  stage={stage}
                />
              ))}
            </div>
          </DndContext>
        ) : (
          <p className="text-slate-400">This pipeline has no stages yet.</p>
        )}
        {move.error && (
          <div className="mt-4">
            <ErrorState error={move.error} />
          </div>
        )}
      </div>
      <OpportunityDialog
        onOpenChange={setShowOpportunity}
        open={showOpportunity}
      />
    </>
  );
};

const OpportunityDetail = ({ id }: { readonly id: string }) => {
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [estimatedValue, setEstimatedValue] = useState('');
  const opportunity = useQuery({
    queryFn: () => request<Opportunity>(`/v1/opportunities/${id}`),
    queryKey: ['opportunity', id],
  });
  const activities = useQuery({
    queryFn: () =>
      request<
        Array<{ body: string; createdAt: string; id: string; kind: string }>
      >(`/v1/opportunities/${id}/activities`),
    queryKey: ['activities', id],
  });
  const addNote = useMutation({
    // The note text is only cleared on success, so a failed add keeps it intact.
    mutationFn: () =>
      request(`/v1/opportunities/${id}/activities`, {
        body: JSON.stringify({ body: note, kind: 'note' }),
        method: 'POST',
      }),
    onSuccess: () => {
      setNote('');
      queryClient.invalidateQueries({ queryKey: ['activities', id] });
    },
  });
  const update = useMutation({
    mutationFn: (input: { estimatedValue?: null | number; name?: string }) =>
      request<Opportunity>(`/v1/opportunities/${id}`, {
        body: JSON.stringify(input),
        method: 'PATCH',
      }),
    onSuccess: () => {
      setEditing(false);
      queryClient.invalidateQueries({ queryKey: ['opportunity', id] });
      queryClient.invalidateQueries({ queryKey: ['opportunities'] });
    },
  });
  if (opportunity.isPending) {
    return <div className="p-8 text-slate-400">Loading opportunity…</div>;
  }

  if (opportunity.error || !opportunity.data) {
    return (
      <div className="p-8">
        <ErrorState
          error={opportunity.error ?? new Error('Opportunity not found.')}
        />
      </div>
    );
  }

  const record = opportunity.data;
  const startEditing = () => {
    update.reset();
    setName(record.name);
    setEstimatedValue(
      record.estimatedValue === null ? '' : String(record.estimatedValue),
    );
    setEditing(true);
  };

  const parsedValue = estimatedValue === '' ? null : Number(estimatedValue);
  const valueInvalid =
    parsedValue !== null && (!Number.isFinite(parsedValue) || parsedValue < 0);
  const hasChanges =
    !valueInvalid &&
    (name.trim() !== record.name || parsedValue !== record.estimatedValue);
  const submitEdit = (event: React.FormEvent) => {
    event.preventDefault();
    const input: { estimatedValue?: null | number; name?: string } = {};
    if (name.trim() !== record.name) {
      input.name = name.trim();
    }

    if (parsedValue !== record.estimatedValue) {
      input.estimatedValue = parsedValue;
    }

    if (Object.keys(input).length === 0) {
      return;
    }

    update.mutate(input);
  };

  return (
    <>
      <Header
        action={
          <Link
            className="text-sm font-medium text-cyan-300 hover:text-cyan-200"
            href="/opportunities"
          >
            Back to work queue
          </Link>
        }
        eyebrow={record.source}
        title={record.name}
      />
      <div className="grid gap-6 p-5 sm:p-8 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="xl:col-span-2 text-xs text-slate-500">
          Opportunity ID{' '}
          <code className="ml-2 font-mono text-slate-300">{record.id}</code>
        </div>
        <div className="grid gap-6">
          <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-5">
            <h2 className="font-semibold text-white">Details</h2>
            {editing ? (
              <form
                className="mt-4 grid gap-3"
                onSubmit={submitEdit}
              >
                <label className="grid gap-1 text-sm text-slate-300">
                  Name
                  <input
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Opportunity name"
                    value={name}
                  />
                </label>
                <label className="grid gap-1 text-sm text-slate-300">
                  Estimated value
                  <input
                    min="0"
                    onChange={(event) => setEstimatedValue(event.target.value)}
                    placeholder="0"
                    type="number"
                    value={estimatedValue}
                  />
                  <InlineFieldError
                    error={valueInvalid}
                    message="Estimated value must be zero or a positive number. Leave it blank to clear the value."
                  />
                </label>
                {update.error && <ErrorState error={update.error} />}
                <div className="flex justify-end gap-2">
                  <Button
                    onClick={() => setEditing(false)}
                    tone="secondary"
                  >
                    Cancel
                  </Button>
                  <Button
                    disabled={update.isPending || !hasChanges}
                    type="submit"
                  >
                    Save changes
                  </Button>
                </div>
              </form>
            ) : (
              <>
                <div className="mt-4 grid gap-3 text-sm">
                  <div className="flex justify-between gap-4">
                    <span className="text-slate-400">Name</span>
                    <span className="text-right font-medium text-slate-100">
                      {record.name}
                    </span>
                  </div>
                  <div className="flex justify-between gap-4">
                    <span className="text-slate-400">Estimated value</span>
                    <span className="font-medium text-slate-100">
                      {record.estimatedValue === null
                        ? 'Not set'
                        : '$' + record.estimatedValue.toLocaleString()}
                    </span>
                  </div>
                </div>
                <div className="mt-4">
                  <Button
                    onClick={startEditing}
                    tone="secondary"
                  >
                    Edit details
                  </Button>
                </div>
              </>
            )}
          </section>
          <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-5">
            <h2 className="font-semibold text-white">Contact</h2>
            <p className="mt-3 text-lg">
              {[record.contact.firstName, record.contact.lastName]
                .filter(Boolean)
                .join(' ') || 'Unnamed contact'}
            </p>
            <p className="text-sm text-slate-400">
              {record.contact.email ?? 'No email'}
            </p>
            <div className="mt-6 grid gap-3 border-t border-slate-800 pt-5 text-sm">
              {Object.entries(record.customFields).map(([key, value]) => (
                <div
                  className="flex justify-between gap-4"
                  key={key}
                >
                  <span className="text-slate-400">{key}</span>
                  <span>{String(value)}</span>
                </div>
              ))}
            </div>
          </section>
        </div>
        <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-5">
          <h2 className="font-semibold text-white">Activity</h2>
          <form
            className="mt-4 grid gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (note.trim()) {
                addNote.mutate();
              }
            }}
          >
            <textarea
              onChange={(event) => setNote(event.target.value)}
              placeholder="Add a note…"
              rows={3}
              value={note}
            />
            <Button
              disabled={addNote.isPending || note.trim() === ''}
              type="submit"
            >
              Add note
            </Button>
          </form>
          {addNote.error && (
            <div className="mt-3">
              <ErrorState error={addNote.error} />
            </div>
          )}
          <div className="mt-5 grid gap-4">
            {activities.isPending ? (
              <p className="text-sm text-slate-400">Loading activity…</p>
            ) : activities.error ? (
              <ErrorState error={activities.error} />
            ) : activities.data?.length ? (
              activities.data.map((activity) => (
                <article
                  className="border-l border-slate-700 pl-3"
                  key={activity.id}
                >
                  <p className="text-sm text-slate-200">{activity.body}</p>
                  <p className="mt-1 text-xs text-slate-500">
                    {activity.kind.replaceAll('_', ' ')} ·{' '}
                    {new Date(activity.createdAt).toLocaleString()}
                  </p>
                </article>
              ))
            ) : (
              <p className="text-sm text-slate-400">No activity yet.</p>
            )}
          </div>
        </section>
      </div>
    </>
  );
};

const ContactsPage = () => {
  const [contactDialog, setContactDialog] = useState<null | {
    contact?: Contact;
  }>(null);
  const [deletingContact, setDeletingContact] = useState<Contact | null>(null);
  const queryClient = useQueryClient();
  const contacts = useQuery(appQuery.contacts());
  const remove = useMutation({
    mutationFn: (contactId: string) =>
      request('/v1/contacts/' + contactId, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
      setDeletingContact(null);
    },
  });
  if (contacts.error) {
    return (
      <div className="p-8">
        <ErrorState error={contacts.error} />
      </div>
    );
  }

  return (
    <>
      <Header
        action={
          <Button onClick={() => setContactDialog({})}>
            <Plus size={16} /> Add contact
          </Button>
        }
        eyebrow="People"
        title="Contacts"
      />
      <div className="p-5 sm:p-8">
        {contacts.isPending ? (
          <p className="text-slate-400">Loading contacts…</p>
        ) : (
          <div className="overflow-hidden rounded-xl border border-slate-800">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-900 text-xs uppercase tracking-wider text-slate-400">
                <tr>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Email</th>
                  <th className="px-4 py-3">Added</th>
                  <th className="px-4 py-3">ID</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {contacts.data?.map((contact) => (
                  <tr
                    className="border-t border-slate-800"
                    key={contact.id}
                  >
                    <td className="px-4 py-3 font-medium text-slate-100">
                      {[contact.firstName, contact.lastName]
                        .filter(Boolean)
                        .join(' ') || 'Unnamed contact'}
                    </td>
                    <td className="px-4 py-3 text-slate-400">
                      {contact.email ?? '—'}
                    </td>
                    <td className="px-4 py-3 text-slate-500">
                      {new Date(contact.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3">
                      <code className="font-mono text-xs text-slate-500">
                        {contact.id}
                      </code>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-2">
                        <Button
                          onClick={() => setContactDialog({ contact })}
                          tone="secondary"
                        >
                          Edit
                        </Button>
                        <Button
                          onClick={() => setDeletingContact(contact)}
                          tone="danger"
                        >
                          Delete
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <ContactDialog
        contact={contactDialog?.contact}
        onOpenChange={(open) => {
          if (!open) {
            setContactDialog(null);
          }
        }}
        open={contactDialog !== null}
      />
      <Dialog
        onOpenChange={(open) => {
          if (!open) {
            setDeletingContact(null);
          }
        }}
        open={deletingContact !== null}
        title="Delete contact"
      >
        <p className="text-sm text-slate-300">
          Delete{' '}
          {deletingContact
            ? [deletingContact.firstName, deletingContact.lastName]
                .filter(Boolean)
                .join(' ') ||
              deletingContact.email ||
              'this contact'
            : 'this contact'}
          ? Contacts with opportunities cannot be deleted.
        </p>
        {remove.error && (
          <div className="mt-4">
            <ErrorState error={remove.error} />
          </div>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button
            onClick={() => setDeletingContact(null)}
            tone="secondary"
          >
            Cancel
          </Button>
          <Button
            disabled={remove.isPending || !deletingContact}
            onClick={() => deletingContact && remove.mutate(deletingContact.id)}
            tone="danger"
          >
            Delete contact
          </Button>
        </div>
      </Dialog>
    </>
  );
};

const FieldDialog = ({
  entityType,
  onOpenChange,
  open,
}: {
  readonly entityType: 'contact' | 'opportunity';
  readonly onOpenChange: (value: boolean) => void;
  readonly open: boolean;
}) => {
  const queryClient = useQueryClient();
  const form = useForm<CreateCustomField>({
    defaultValues: {
      entityType,
      key: '',
      label: '',
      required: false,
      type: 'text',
    },
    resolver: effectTsResolver(CreateCustomFieldSchema),
  });
  useEffect(() => {
    if (open) {
      form.reset({
        entityType,
        key: '',
        label: '',
        required: false,
        type: 'text',
      });
    }
  }, [entityType, form, open]);
  const create = useMutation({
    mutationFn: (input: CreateCustomField) =>
      request('/v1/custom-fields', {
        body: JSON.stringify({
          ...input,
          options: input.options?.filter(Boolean),
        }),
        method: 'POST',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fields', entityType] });
      onOpenChange(false);
    },
  });
  const recordLabel = entityType === 'contact' ? 'contact' : 'opportunity';
  return (
    <Dialog
      onOpenChange={onOpenChange}
      open={open}
      title={'Add ' + recordLabel + ' field'}
    >
      <form
        className="grid gap-3"
        onSubmit={form.handleSubmit((values) => create.mutate(values))}
      >
        <label className="grid gap-1 text-sm">
          Label
          <input
            {...form.register('label')}
            placeholder="Cohort"
          />
          <InlineFieldError
            error={form.formState.errors.label}
            message="Enter a field label."
          />
        </label>
        <label className="grid gap-1 text-sm">
          Key
          <input
            {...form.register('key')}
            placeholder="cohort"
          />
          <InlineFieldError
            error={form.formState.errors.key}
            message="Use lowercase letters, numbers, and underscores, starting with a letter."
          />
        </label>
        <label className="grid gap-1 text-sm">
          Type
          <select {...form.register('type')}>
            <option value="text">Text</option>
            <option value="number">Number</option>
            <option value="boolean">Boolean</option>
            <option value="date">Date</option>
            <option value="select">Select</option>
          </select>
          <InlineFieldError
            error={form.formState.errors.type}
            message="Choose a field type."
          />
        </label>
        <label className="flex gap-2 text-sm">
          <input
            type="checkbox"
            {...form.register('required')}
          />{' '}
          Required
        </label>
        {create.error && <ErrorState error={create.error} />}
        <div className="flex justify-end gap-2">
          <Button
            onClick={() => onOpenChange(false)}
            tone="secondary"
          >
            Cancel
          </Button>
          <Button
            disabled={create.isPending}
            type="submit"
          >
            <Plus size={16} /> Add field
          </Button>
        </div>
      </form>
    </Dialog>
  );
};

const FieldsPage = () => {
  const queryClient = useQueryClient();
  const [entityType, setEntityType] = useState<'contact' | 'opportunity'>(
    'opportunity',
  );
  const [showFieldDialog, setShowFieldDialog] = useState(false);
  const fields = useQuery({
    queryFn: () =>
      request<FieldDefinition[]>('/v1/custom-fields?entityType=' + entityType),
    queryKey: ['fields', entityType],
  });
  const archive = useMutation({
    mutationFn: (id: string) =>
      request('/v1/custom-fields/' + id, { method: 'DELETE' }),
    onSuccess: async () => {
      await Promise.all([
        fields.refetch(),
        queryClient.invalidateQueries({ queryKey: ['contacts'] }),
        queryClient.invalidateQueries({ queryKey: ['opportunities'] }),
        queryClient.invalidateQueries({ queryKey: ['opportunity'] }),
      ]);
    },
  });
  const recordLabel = entityType === 'contact' ? 'Contact' : 'Opportunity';
  return (
    <>
      <Header
        action={
          <Button onClick={() => setShowFieldDialog(true)}>
            <Plus size={16} /> Add field
          </Button>
        }
        eyebrow="Configuration"
        title="Custom fields"
      />
      <div className="p-5 sm:p-8">
        <div
          aria-label="Field record type"
          className="mb-6 inline-flex rounded-lg border border-slate-800 bg-slate-900 p-1"
          role="tablist"
        >
          {(['opportunity', 'contact'] as const).map((type) => (
            <button
              aria-selected={entityType === type}
              className={cn(
                'rounded-md px-4 py-2 text-sm font-medium transition',
                entityType === type
                  ? 'bg-cyan-400 text-slate-950'
                  : 'text-slate-400 hover:text-slate-100',
              )}
              key={type}
              onClick={() => setEntityType(type)}
              role="tab"
              type="button"
            >
              {type === 'opportunity' ? 'Opportunity' : 'Contact'}
            </button>
          ))}
        </div>
        <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-5">
          <h2 className="font-semibold text-white">
            Active {recordLabel.toLowerCase()} fields
          </h2>
          {fields.isPending ? (
            <p className="mt-4 text-sm text-slate-400">Loading fields…</p>
          ) : fields.data?.length ? (
            <div className="mt-4 grid gap-2">
              {fields.data.map((field) => (
                <div
                  className="flex items-center justify-between gap-4 rounded-md border border-slate-800 p-3"
                  key={field.id}
                >
                  <div>
                    <p className="font-medium">{field.label}</p>
                    <p className="text-xs text-slate-500">
                      {field.key} · {field.type}
                    </p>
                  </div>
                  <Button
                    onClick={() => archive.mutate(field.id)}
                    tone="secondary"
                  >
                    Archive
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-4 text-sm text-slate-400">
              No {recordLabel.toLowerCase()} fields yet.
            </p>
          )}
          {fields.error && (
            <div className="mt-4">
              <ErrorState error={fields.error} />
            </div>
          )}
          {archive.error && (
            <div className="mt-4">
              <ErrorState error={archive.error} />
            </div>
          )}
        </section>
      </div>
      <FieldDialog
        entityType={entityType}
        onOpenChange={setShowFieldDialog}
        open={showFieldDialog}
      />
    </>
  );
};

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
        <Route path="/opportunities/:id">
          {(parameters) => <OpportunityDetail id={parameters.id} />}
        </Route>
        <Route path="/opportunities">
          <OpportunitiesPage />
        </Route>
        <Route path="/contacts">
          <ContactsPage />
        </Route>
        <Route path="/settings/fields">
          <FieldsPage />
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
          <OpportunitiesPage />
        </Route>
      </Switch>
    </Shell>
  );
};
