import { DndContext, useDraggable, useDroppable, type DragEndEvent } from '@dnd-kit/core';
import { effectTsResolver } from '@hookform/resolvers/effect-ts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronRight,
  ContactRound,
  KeyRound,
  LayoutList,
  PanelsTopLeft,
  Plus,
  Settings2,
  SlidersHorizontal,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, Route, Switch, useLocation } from 'wouter';
import { Button } from './components/ui/button';
import { Dialog } from './components/ui/dialog';
import {
  ContactInputSchema,
  CreateCustomFieldSchema,
  type ContactInput,
  type CreateCustomField,
} from './domain/schemas';
import { request } from './lib/http';
import { cn } from './lib/styles';
import {
  customFieldsForCreate,
  customFieldsForUpdate,
  isBlankCustomFieldValue,
} from './lib/custom-field-form';

type Contact = {
  createdAt: string;
  customFields: Record<string, unknown>;
  email: string | null;
  firstName: string | null;
  id: string;
  lastName: string | null;
};

type Opportunity = {
  contact: Contact;
  createdAt: string;
  customFields: Record<string, unknown>;
  estimatedValue: number | null;
  id: string;
  name: string;
  pipelineId: string;
  source: string;
  stageId: string;
};

type Stage = { color: string; id: string; name: string; position: number };
type Pipeline = { id: string; name: string; stages: Stage[] };
type FieldDefinition = {
  entityType: 'contact' | 'opportunity';
  id: string;
  key: string;
  label: string;
  options: string[];
  required: boolean;
  type: 'boolean' | 'date' | 'number' | 'select' | 'text';
};
type Token = { createdAt: string; id: string; name: string; prefix: string; revokedAt: string | null };

const navigation = [
  { href: '/opportunities', icon: LayoutList, label: 'Opportunities' },
  { href: '/contacts', icon: ContactRound, label: 'Contacts' },
  { href: '/settings/fields', icon: SlidersHorizontal, label: 'Fields' },
  { href: '/settings/tokens', icon: KeyRound, label: 'Tokens' },
];

const appQuery = {
  contacts: () => ({ queryFn: () => request<Contact[]>('/v1/contacts'), queryKey: ['contacts'] }),
  opportunities: () => ({ queryFn: () => request<Opportunity[]>('/v1/opportunities'), queryKey: ['opportunities'] }),
  pipelines: () => ({ queryFn: () => request<Pipeline[]>('/v1/pipelines'), queryKey: ['pipelines'] }),
};

const ErrorState = ({ error }: { error: unknown }) => (
  <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-100">
    {error instanceof Error ? error.message : 'Something went wrong.'}
  </div>
);

const emptyToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim().length === 0 ? undefined : value;

const InlineFieldError = ({ error, message }: { error?: unknown; message: string }) =>
  error ? <p className="mt-1 text-sm text-rose-300">{message}</p> : null;

const validateRequiredCustomFields = (
  definitions: FieldDefinition[],
  values: Record<string, unknown>,
): Record<string, string> =>
  Object.fromEntries(
    definitions
      .filter((field) => field.required && isBlankCustomFieldValue(values[field.key]))
      .map((field) => [field.key, field.label + ' is required.']),
  );

const CustomFieldInputs = ({
  definitions,
  errors,
  onChange,
  values,
}: {
  definitions: FieldDefinition[];
  errors: Record<string, string>;
  onChange: (key: string, value: unknown) => void;
  values: Record<string, unknown>;
}) => {
  if (definitions.length === 0) return null;
  return (
    <fieldset className="grid gap-3 border-t border-slate-800 pt-4">
      <legend className="px-0 text-sm font-medium text-slate-200">Custom fields</legend>
      {definitions.map((field) => {
        const error = errors[field.key];
        const label = <span>{field.label}{field.required && <span className="ml-1 text-rose-300">*</span>}</span>;
        if (field.type === 'boolean') {
          return <label key={field.id} className="grid gap-1 text-sm text-slate-300">{label}<span className="flex gap-2"><input checked={Boolean(values[field.key])} onChange={(event) => onChange(field.key, event.target.checked)} type="checkbox" /> Yes</span>{error && <p className="text-sm text-rose-300">{error}</p>}</label>;
        }
        if (field.type === 'select') {
          return <label key={field.id} className="grid gap-1 text-sm text-slate-300">{label}<select onChange={(event) => onChange(field.key, event.target.value === '' ? null : event.target.value)} value={String(values[field.key] ?? '')}><option value="">Choose an option…</option>{field.options.map((option) => <option key={option} value={option}>{option}</option>)}</select>{error && <p className="text-sm text-rose-300">{error}</p>}</label>;
        }
        return <label key={field.id} className="grid gap-1 text-sm text-slate-300">{label}<input onChange={(event) => onChange(field.key, field.type === 'number' ? (event.target.value === '' ? null : Number(event.target.value)) : (event.target.value === '' ? null : event.target.value))} type={field.type === 'date' ? 'date' : field.type === 'number' ? 'number' : 'text'} value={String(values[field.key] ?? '')} />{error && <p className="text-sm text-rose-300">{error}</p>}</label>;
      })}
    </fieldset>
  );
};

const Shell = ({ children }: { children: React.ReactNode }) => {
  const [location] = useLocation();
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 lg:grid lg:grid-cols-[14rem_1fr]">
      <aside className="border-b border-slate-800 bg-slate-900/70 p-4 lg:min-h-screen lg:border-b-0 lg:border-r">
        <Link href="/opportunities" className="mb-8 flex items-center gap-2 px-2 text-sm font-bold tracking-tight text-white">
          <span className="grid size-7 place-items-center rounded-md bg-cyan-400 text-slate-950"><PanelsTopLeft size={16} /></span>
          Lead Desk
        </Link>
        <nav className="grid grid-cols-2 gap-1 sm:flex sm:flex-wrap lg:grid lg:grid-cols-1">
          {navigation.map((item) => {
            const Icon = item.icon;
            const active = location === item.href || location.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition',
                  active ? 'bg-slate-800 text-cyan-300' : 'text-slate-400 hover:bg-slate-800/70 hover:text-slate-100',
                )}
              >
                <Icon size={16} />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="mt-6 border-t border-slate-800 pt-4 text-xs leading-relaxed text-slate-500">
          Cloudflare-native CRM alpha
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
  action?: React.ReactNode;
  eyebrow?: string;
  title: string;
}) => (
  <header className="flex flex-wrap items-end justify-between gap-4 border-b border-slate-800 px-5 py-5 sm:px-8">
    <div>
      {eyebrow && <p className="mb-1 text-xs font-semibold uppercase tracking-[0.16em] text-cyan-400">{eyebrow}</p>}
      <h1 className="text-2xl font-semibold tracking-tight text-white">{title}</h1>
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
  open,
  onOpenChange,
}: {
  contact?: Contact | null;
  onOpenChange: (value: boolean) => void;
  open: boolean;
}) => {
  const queryClient = useQueryClient();
  const fieldDefinitions = useQuery({ queryFn: () => request<FieldDefinition[]>('/v1/custom-fields?entityType=contact'), queryKey: ['fields', 'contact'] });
  const [customFields, setCustomFields] = useState<Record<string, unknown>>({});
  const [customFieldErrors, setCustomFieldErrors] = useState<Record<string, string>>({});
  const form = useForm<ContactInput>({
    defaultValues: contactFormValues(contact),
    resolver: effectTsResolver(ContactInputSchema),
  });
  useEffect(() => {
    if (!open) return;
    form.reset(contactFormValues(contact));
    setCustomFields(contact?.customFields ?? {});
    setCustomFieldErrors({});
  }, [contact, form, open]);
  const mutation = useMutation({
    mutationFn: (input: ContactInput) => request<Contact>(
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
  const submit = (values: ContactInput) => {
    const errors = validateRequiredCustomFields(fieldDefinitions.data ?? [], customFields);
    setCustomFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;
    const input = normalizeContactInput(values);
    if (!input.email && !input.firstName && !input.lastName) {
      form.setError('firstName', { message: 'identity_required' });
      return;
    }
    mutation.mutate({
      ...input,
      customFields: editing
        ? customFieldsForUpdate(customFields)
        : customFieldsForCreate(customFields),
    });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={editing ? 'Edit contact' : 'New contact'}>
      <form className="grid gap-4" onSubmit={form.handleSubmit(submit)}>
        <label className="grid gap-1 text-sm text-slate-300">First name<input {...form.register('firstName', { setValueAs: emptyToUndefined })} placeholder="Sam" /><InlineFieldError error={form.formState.errors.firstName} message="Enter a first name, last name, or email address." /></label>
        <label className="grid gap-1 text-sm text-slate-300">Last name<input {...form.register('lastName', { setValueAs: emptyToUndefined })} placeholder="Morgan" /><InlineFieldError error={form.formState.errors.lastName} message="Enter a last name or leave this optional field blank." /></label>
        <label className="grid gap-1 text-sm text-slate-300">Email<input {...form.register('email', { setValueAs: emptyToUndefined })} placeholder="alex@example.com" type="email" /><InlineFieldError error={form.formState.errors.email} message="Enter a valid email address." /></label>
        {fieldDefinitions.isPending ? <p className="text-sm text-slate-400">Loading custom fields…</p> : <CustomFieldInputs definitions={fieldDefinitions.data ?? []} errors={customFieldErrors} onChange={(key, value) => setCustomFields((current) => ({ ...current, [key]: value }))} values={customFields} />}
        {fieldDefinitions.error && <ErrorState error={fieldDefinitions.error} />}
        {mutation.error && <ErrorState error={mutation.error} />}
        <div className="flex justify-end gap-2"><Button tone="secondary" onClick={() => onOpenChange(false)}>Cancel</Button><Button disabled={mutation.isPending || fieldDefinitions.isPending} type="submit">{editing ? 'Save changes' : 'Create contact'}</Button></div>
      </form>
    </Dialog>
  );
};

type ManualOpportunityForm = {
  contactId: string;
  contactMode: 'existing' | 'new';
  estimatedValue: string;
  firstName: string;
  lastName: string;
  name: string;
  email: string;
  pipelineId: string;
  source: string;
  stageId: string;
};

const OpportunityDialog = ({ open, onOpenChange }: { onOpenChange: (value: boolean) => void; open: boolean }) => {
  const queryClient = useQueryClient();
  const contacts = useQuery(appQuery.contacts());
  const pipelines = useQuery(appQuery.pipelines());
  const contactFieldDefinitions = useQuery({ queryFn: () => request<FieldDefinition[]>('/v1/custom-fields?entityType=contact'), queryKey: ['fields', 'contact'] });
  const opportunityFieldDefinitions = useQuery({ queryFn: () => request<FieldDefinition[]>('/v1/custom-fields?entityType=opportunity'), queryKey: ['fields', 'opportunity'] });
  const [contactCustomFields, setContactCustomFields] = useState<Record<string, unknown>>({});
  const [opportunityCustomFields, setOpportunityCustomFields] = useState<Record<string, unknown>>({});
  const [contactCustomErrors, setContactCustomErrors] = useState<Record<string, string>>({});
  const [opportunityCustomErrors, setOpportunityCustomErrors] = useState<Record<string, string>>({});
  const form = useForm<ManualOpportunityForm>({
    defaultValues: { contactId: '', contactMode: 'existing', email: '', estimatedValue: '', firstName: '', lastName: '', name: '', pipelineId: '', source: 'Manual entry', stageId: '' },
  });
  const availablePipelines = (pipelines.data ?? []).filter((pipeline) => pipeline.stages.length > 0);
  const pipelineId = form.watch('pipelineId');
  const selectedPipeline = availablePipelines.find((pipeline) => pipeline.id === pipelineId);
  useEffect(() => {
    if (!open) return;
    const pipeline = availablePipelines[0];
    form.reset({ contactId: '', contactMode: 'existing', email: '', estimatedValue: '', firstName: '', lastName: '', name: '', pipelineId: pipeline?.id ?? '', source: 'Manual entry', stageId: pipeline?.stages[0]?.id ?? '' });
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
          : { contact: { ...normalizeContactInput({ email: values.email, firstName: values.firstName, lastName: values.lastName }), customFields: customFieldsForCreate(contactCustomFields) } }),
        customFields: customFieldsForCreate(opportunityCustomFields),
        estimatedValue: values.estimatedValue ? Number(values.estimatedValue) : undefined,
        name: values.name.trim(),
        pipelineId: values.pipelineId,
        source: values.source.trim() || undefined,
        stageId: values.stageId,
      };
      return request<Opportunity>('/v1/opportunities', { body: JSON.stringify(body), method: 'POST' });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
      queryClient.invalidateQueries({ queryKey: ['opportunities'] });
      onOpenChange(false);
    },
  });
  const contactMode = form.watch('contactMode');
  const submit = (values: ManualOpportunityForm) => {
    const nextContactErrors = values.contactMode === 'new'
      ? validateRequiredCustomFields(contactFieldDefinitions.data ?? [], contactCustomFields)
      : {};
    const nextOpportunityErrors = validateRequiredCustomFields(opportunityFieldDefinitions.data ?? [], opportunityCustomFields);
    setContactCustomErrors(nextContactErrors);
    setOpportunityCustomErrors(nextOpportunityErrors);
    if (Object.keys(nextContactErrors).length > 0 || Object.keys(nextOpportunityErrors).length > 0) return;
    mutation.mutate(values);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="New opportunity">
      <form className="grid gap-4" onSubmit={form.handleSubmit(submit)}>
        <label className="grid gap-1 text-sm text-slate-300">Opportunity name<input {...form.register('name')} placeholder="New service inquiry" required /></label>
        <label className="grid gap-1 text-sm text-slate-300">Contact<select {...form.register('contactMode')}><option value="existing">Select an existing contact</option><option value="new">Create a new contact</option></select></label>
        {contactMode === 'existing' ? (
          <label className="grid gap-1 text-sm text-slate-300">Existing contact<select {...form.register('contactId')} required><option value="">Choose a contact…</option>{contacts.data?.map((contact) => <option key={contact.id} value={contact.id}>{[contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.email || 'Unnamed contact'}</option>)}</select></label>
        ) : (
          <div className="grid gap-3 rounded-lg border border-slate-800 bg-slate-950/50 p-3"><p className="text-sm font-medium text-slate-200">New contact</p><label className="grid gap-1 text-sm text-slate-300">First name<input {...form.register('firstName')} placeholder="Sam" /></label><label className="grid gap-1 text-sm text-slate-300">Last name<input {...form.register('lastName')} placeholder="Morgan" /></label><label className="grid gap-1 text-sm text-slate-300">Email<input {...form.register('email')} placeholder="alex@example.com" type="email" /></label>{contactFieldDefinitions.isPending ? <p className="text-sm text-slate-400">Loading custom fields…</p> : <CustomFieldInputs definitions={contactFieldDefinitions.data ?? []} errors={contactCustomErrors} onChange={(key, value) => setContactCustomFields((current) => ({ ...current, [key]: value }))} values={contactCustomFields} />}</div>
        )}
        <div className="grid gap-3 sm:grid-cols-2"><label className="grid gap-1 text-sm text-slate-300">Pipeline<select {...form.register('pipelineId')} onChange={(event) => { const next = availablePipelines.find((pipeline) => pipeline.id === event.target.value); form.setValue('pipelineId', event.target.value); form.setValue('stageId', next?.stages[0]?.id ?? ''); }} required><option value="">Choose a pipeline…</option>{availablePipelines.map((pipeline) => <option key={pipeline.id} value={pipeline.id}>{pipeline.name}</option>)}</select></label><label className="grid gap-1 text-sm text-slate-300">Stage<select {...form.register('stageId')} required><option value="">Choose a stage…</option>{selectedPipeline?.stages.map((stage) => <option key={stage.id} value={stage.id}>{stage.name}</option>)}</select></label></div>
        <div className="grid gap-3 sm:grid-cols-2"><label className="grid gap-1 text-sm text-slate-300">Source<input {...form.register('source')} placeholder="Manual entry" /></label><label className="grid gap-1 text-sm text-slate-300">Estimated value<input {...form.register('estimatedValue')} min="0" placeholder="5000" type="number" /></label></div>
        {opportunityFieldDefinitions.isPending ? <p className="text-sm text-slate-400">Loading custom fields…</p> : <CustomFieldInputs definitions={opportunityFieldDefinitions.data ?? []} errors={opportunityCustomErrors} onChange={(key, value) => setOpportunityCustomFields((current) => ({ ...current, [key]: value }))} values={opportunityCustomFields} />}
        {contactFieldDefinitions.error && <ErrorState error={contactFieldDefinitions.error} />}
        {opportunityFieldDefinitions.error && <ErrorState error={opportunityFieldDefinitions.error} />}
        {mutation.error && <ErrorState error={mutation.error} />}
        <div className="flex justify-end gap-2"><Button tone="secondary" onClick={() => onOpenChange(false)}>Cancel</Button><Button disabled={mutation.isPending || contacts.isPending || pipelines.isPending || contactFieldDefinitions.isPending || opportunityFieldDefinitions.isPending || !selectedPipeline} type="submit">Create opportunity</Button></div>
      </form>
    </Dialog>
  );
};

const StageColumn = ({
  opportunities,
  stage,
}: {
  opportunities: Opportunity[];
  stage: Stage;
}) => {
  const { isOver, setNodeRef } = useDroppable({ id: stage.id });
  return (
    <section ref={setNodeRef} className={cn('min-h-56 rounded-lg border p-3 transition', isOver ? 'border-cyan-400 bg-cyan-400/5' : 'border-slate-800 bg-slate-900/40')}>
      <div className="mb-3 flex items-center justify-between"><span className="text-sm font-semibold text-slate-200">{stage.name}</span><span className="rounded-full bg-slate-800 px-2 py-0.5 text-xs text-slate-400">{opportunities.length}</span></div>
      <div className="grid gap-2">
        {opportunities.map((opportunity) => <OpportunityCard key={opportunity.id} opportunity={opportunity} />)}
      </div>
    </section>
  );
};

const OpportunityCard = ({ opportunity }: { opportunity: Opportunity }) => {
  const { attributes, listeners, setNodeRef, transform } = useDraggable({ id: opportunity.id });
  return (
    <Link
      ref={setNodeRef}
      href={`/opportunities/${opportunity.id}`}
      {...attributes}
      {...listeners}
      className="block cursor-grab rounded-md border border-slate-800 bg-slate-950 p-3 shadow-sm hover:border-slate-600 active:cursor-grabbing"
      style={transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined}
    >
      <p className="text-sm font-semibold text-slate-100">{opportunity.name}</p>
      <p className="mt-1 text-xs text-slate-400">{[opportunity.contact.firstName, opportunity.contact.lastName].filter(Boolean).join(' ') || opportunity.contact.email}</p>
      <div className="mt-3 flex items-center justify-between text-xs text-slate-500"><span>{opportunity.source}</span><code className="font-mono text-[0.68rem] text-slate-600">{opportunity.id}</code>{opportunity.estimatedValue !== null && <span>${opportunity.estimatedValue.toLocaleString()}</span>}</div>
    </Link>
  );
};

const OpportunitiesPage = () => {
  const [showOpportunity, setShowOpportunity] = useState(false);
  const queryClient = useQueryClient();
  const opportunities = useQuery(appQuery.opportunities());
  const pipelines = useQuery(appQuery.pipelines());
  const move = useMutation({
    mutationFn: ({ opportunityId, stageId }: { opportunityId: string; stageId: string }) => request<Opportunity>(`/v1/opportunities/${opportunityId}/move`, { body: JSON.stringify({ stageId }), method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['opportunities'] }),
  });
  const onDragEnd = (event: DragEndEvent) => {
    if (!event.over || event.active.id === event.over.id) return;
    move.mutate({ opportunityId: String(event.active.id), stageId: String(event.over.id) });
  };
  if (opportunities.error || pipelines.error) return <div className="p-8"><ErrorState error={opportunities.error ?? pipelines.error} /></div>;
  const pipeline = pipelines.data?.[0];
  return (
    <>
      <Header eyebrow="Work queue" title="Opportunities" action={<Button onClick={() => setShowOpportunity(true)}><Plus size={16} /> Add opportunity</Button>} />
      <div className="p-5 sm:p-8">
        <div className="mb-5 flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/40 p-3 text-sm text-slate-400"><Settings2 size={16} /> Drag an opportunity between stages to update its pipeline.</div>
        {opportunities.isPending || pipelines.isPending ? <p className="text-slate-400">Loading work queue…</p> : (
          <DndContext onDragEnd={onDragEnd}>
            <div className="grid gap-4 overflow-x-auto md:grid-cols-2 xl:grid-cols-3">
              {pipeline?.stages.map((stage) => <StageColumn key={stage.id} stage={stage} opportunities={(opportunities.data ?? []).filter((opportunity) => opportunity.stageId === stage.id)} />)}
            </div>
          </DndContext>
        )}
        {move.error && <div className="mt-4"><ErrorState error={move.error} /></div>}
      </div>
      <OpportunityDialog open={showOpportunity} onOpenChange={setShowOpportunity} />
    </>
  );
};

const OpportunityDetail = ({ id }: { id: string }) => {
  const queryClient = useQueryClient();
  const [note, setNote] = useState('');
  const opportunity = useQuery({ queryFn: () => request<Opportunity>(`/v1/opportunities/${id}`), queryKey: ['opportunity', id] });
  const activities = useQuery({ queryFn: () => request<Array<{ body: string; createdAt: string; id: string; kind: string }>>(`/v1/opportunities/${id}/activities`), queryKey: ['activities', id] });
  const addNote = useMutation({
    mutationFn: () => request(`/v1/opportunities/${id}/activities`, { body: JSON.stringify({ body: note, kind: 'note' }), method: 'POST' }),
    onSuccess: () => { setNote(''); queryClient.invalidateQueries({ queryKey: ['activities', id] }); },
  });
  if (opportunity.isPending) return <div className="p-8 text-slate-400">Loading opportunity…</div>;
  if (opportunity.error || !opportunity.data) return <div className="p-8"><ErrorState error={opportunity.error ?? new Error('Opportunity not found.')} /></div>;
  const record = opportunity.data;
  return <>
    <Header eyebrow={record.source} title={record.name} action={<Link href="/opportunities" className="text-sm font-medium text-cyan-300 hover:text-cyan-200">Back to work queue</Link>} />
    <div className="grid gap-6 p-5 sm:p-8 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="xl:col-span-2 text-xs text-slate-500">Opportunity ID <code className="ml-2 font-mono text-slate-300">{record.id}</code></div>
      <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-5"><h2 className="font-semibold text-white">Contact</h2><p className="mt-3 text-lg">{[record.contact.firstName, record.contact.lastName].filter(Boolean).join(' ') || 'Unnamed contact'}</p><p className="text-sm text-slate-400">{record.contact.email ?? 'No email'}</p><div className="mt-6 grid gap-3 border-t border-slate-800 pt-5 text-sm">{Object.entries(record.customFields).map(([key, value]) => <div key={key} className="flex justify-between gap-4"><span className="text-slate-400">{key}</span><span>{String(value)}</span></div>)}</div></section>
      <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-5"><h2 className="font-semibold text-white">Activity</h2><form className="mt-4 grid gap-2" onSubmit={(event) => { event.preventDefault(); if (note.trim()) addNote.mutate(); }}><textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Add a note…" rows={3} /><Button disabled={addNote.isPending} type="submit">Add note</Button></form><div className="mt-5 grid gap-4">{activities.data?.map((activity) => <article key={activity.id} className="border-l border-slate-700 pl-3"><p className="text-sm text-slate-200">{activity.body}</p><p className="mt-1 text-xs text-slate-500">{activity.kind.replaceAll('_', ' ')} · {new Date(activity.createdAt).toLocaleString()}</p></article>)}</div></section>
    </div>
  </>;
};

const ContactsPage = () => {
  const [contactDialog, setContactDialog] = useState<{ contact?: Contact } | null>(null);
  const [deletingContact, setDeletingContact] = useState<Contact | null>(null);
  const queryClient = useQueryClient();
  const contacts = useQuery(appQuery.contacts());
  const remove = useMutation({
    mutationFn: (contactId: string) => request('/v1/contacts/' + contactId, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
      setDeletingContact(null);
    },
  });
  if (contacts.error) return <div className="p-8"><ErrorState error={contacts.error} /></div>;
  return (
    <>
      <Header eyebrow="People" title="Contacts" action={<Button onClick={() => setContactDialog({})}><Plus size={16} /> Add contact</Button>} />
      <div className="p-5 sm:p-8">
        {contacts.isPending ? <p className="text-slate-400">Loading contacts…</p> : (
          <div className="overflow-hidden rounded-xl border border-slate-800">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-900 text-xs uppercase tracking-wider text-slate-400"><tr><th className="px-4 py-3">Name</th><th className="px-4 py-3">Email</th><th className="px-4 py-3">Added</th><th className="px-4 py-3">ID</th><th className="px-4 py-3 text-right">Actions</th></tr></thead>
              <tbody>{contacts.data?.map((contact) => <tr key={contact.id} className="border-t border-slate-800"><td className="px-4 py-3 font-medium text-slate-100">{[contact.firstName, contact.lastName].filter(Boolean).join(' ') || 'Unnamed contact'}</td><td className="px-4 py-3 text-slate-400">{contact.email ?? '—'}</td><td className="px-4 py-3 text-slate-500">{new Date(contact.createdAt).toLocaleDateString()}</td><td className="px-4 py-3"><code className="font-mono text-xs text-slate-500">{contact.id}</code></td><td className="px-4 py-3"><div className="flex justify-end gap-2"><Button tone="secondary" onClick={() => setContactDialog({ contact })}>Edit</Button><Button tone="danger" onClick={() => setDeletingContact(contact)}>Delete</Button></div></td></tr>)}</tbody>
            </table>
          </div>
        )}
      </div>
      <ContactDialog contact={contactDialog?.contact} open={contactDialog !== null} onOpenChange={(open) => { if (!open) setContactDialog(null); }} />
      <Dialog open={deletingContact !== null} onOpenChange={(open) => { if (!open) setDeletingContact(null); }} title="Delete contact">
        <p className="text-sm text-slate-300">Delete {deletingContact ? ([deletingContact.firstName, deletingContact.lastName].filter(Boolean).join(' ') || deletingContact.email || 'this contact') : 'this contact'}? Contacts with opportunities cannot be deleted.</p>
        {remove.error && <div className="mt-4"><ErrorState error={remove.error} /></div>}
        <div className="mt-5 flex justify-end gap-2"><Button tone="secondary" onClick={() => setDeletingContact(null)}>Cancel</Button><Button disabled={remove.isPending || !deletingContact} tone="danger" onClick={() => deletingContact && remove.mutate(deletingContact.id)}>Delete contact</Button></div>
      </Dialog>
    </>
  );
};

const FieldDialog = ({
  entityType,
  open,
  onOpenChange,
}: {
  entityType: 'contact' | 'opportunity';
  onOpenChange: (value: boolean) => void;
  open: boolean;
}) => {
  const queryClient = useQueryClient();
  const form = useForm<CreateCustomField>({
    defaultValues: { entityType, key: '', label: '', required: false, type: 'text' },
    resolver: effectTsResolver(CreateCustomFieldSchema),
  });
  useEffect(() => {
    if (open) form.reset({ entityType, key: '', label: '', required: false, type: 'text' });
  }, [entityType, form, open]);
  const create = useMutation({
    mutationFn: (input: CreateCustomField) => request('/v1/custom-fields', { body: JSON.stringify({ ...input, options: input.options?.filter(Boolean) }), method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fields', entityType] });
      onOpenChange(false);
    },
  });
  const recordLabel = entityType === 'contact' ? 'contact' : 'opportunity';
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={'Add ' + recordLabel + ' field'}>
      <form className="grid gap-3" onSubmit={form.handleSubmit((values) => create.mutate(values))}>
        <label className="grid gap-1 text-sm">Label<input {...form.register('label')} placeholder="Cohort" /><InlineFieldError error={form.formState.errors.label} message="Enter a field label." /></label>
        <label className="grid gap-1 text-sm">Key<input {...form.register('key')} placeholder="cohort" /><InlineFieldError error={form.formState.errors.key} message="Use lowercase letters, numbers, and underscores, starting with a letter." /></label>
        <label className="grid gap-1 text-sm">Type<select {...form.register('type')}><option value="text">Text</option><option value="number">Number</option><option value="boolean">Boolean</option><option value="date">Date</option><option value="select">Select</option></select><InlineFieldError error={form.formState.errors.type} message="Choose a field type." /></label>
        <label className="flex gap-2 text-sm"><input type="checkbox" {...form.register('required')} /> Required</label>
        {create.error && <ErrorState error={create.error} />}
        <div className="flex justify-end gap-2"><Button tone="secondary" onClick={() => onOpenChange(false)}>Cancel</Button><Button disabled={create.isPending} type="submit"><Plus size={16} /> Add field</Button></div>
      </form>
    </Dialog>
  );
};

const FieldsPage = () => {
  const [entityType, setEntityType] = useState<'contact' | 'opportunity'>('opportunity');
  const [showFieldDialog, setShowFieldDialog] = useState(false);
  const fields = useQuery({ queryFn: () => request<FieldDefinition[]>('/v1/custom-fields?entityType=' + entityType), queryKey: ['fields', entityType] });
  const archive = useMutation({
    mutationFn: (id: string) => request('/v1/custom-fields/' + id, { method: 'DELETE' }),
    onSuccess: () => fields.refetch(),
  });
  const recordLabel = entityType === 'contact' ? 'Contact' : 'Opportunity';
  return (
    <>
      <Header eyebrow="Configuration" title="Custom fields" action={<Button onClick={() => setShowFieldDialog(true)}><Plus size={16} /> Add field</Button>} />
      <div className="p-5 sm:p-8">
        <div className="mb-6 inline-flex rounded-lg border border-slate-800 bg-slate-900 p-1" role="tablist" aria-label="Field record type">
          {(['opportunity', 'contact'] as const).map((type) => <button key={type} type="button" role="tab" aria-selected={entityType === type} onClick={() => setEntityType(type)} className={cn('rounded-md px-4 py-2 text-sm font-medium transition', entityType === type ? 'bg-cyan-400 text-slate-950' : 'text-slate-400 hover:text-slate-100')}>{type === 'opportunity' ? 'Opportunity' : 'Contact'}</button>)}
        </div>
        <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-5">
          <h2 className="font-semibold text-white">Active {recordLabel.toLowerCase()} fields</h2>
          {fields.isPending ? <p className="mt-4 text-sm text-slate-400">Loading fields…</p> : fields.data?.length ? <div className="mt-4 grid gap-2">{fields.data.map((field) => <div key={field.id} className="flex items-center justify-between gap-4 rounded-md border border-slate-800 p-3"><div><p className="font-medium">{field.label}</p><p className="text-xs text-slate-500">{field.key} · {field.type}</p></div><Button tone="secondary" onClick={() => archive.mutate(field.id)}>Archive</Button></div>)}</div> : <p className="mt-4 text-sm text-slate-400">No {recordLabel.toLowerCase()} fields yet.</p>}
          {fields.error && <div className="mt-4"><ErrorState error={fields.error} /></div>}
          {archive.error && <div className="mt-4"><ErrorState error={archive.error} /></div>}
        </section>
      </div>
      <FieldDialog entityType={entityType} open={showFieldDialog} onOpenChange={setShowFieldDialog} />
    </>
  );
};

const TokensPage = () => {
  const queryClient = useQueryClient();
  const [name, setName] = useState('Website form intake');
  const [newToken, setNewToken] = useState<string | null>(null);
  const tokens = useQuery({ queryFn: () => request<Token[]>('/v1/tokens'), queryKey: ['tokens'] });
  const create = useMutation({ mutationFn: () => request<Token & { token: string }>('/v1/tokens', { body: JSON.stringify({ name }), method: 'POST' }), onSuccess: (token) => { setNewToken(token.token); queryClient.invalidateQueries({ queryKey: ['tokens'] }); } });
  const revoke = useMutation({ mutationFn: (id: string) => request(`/v1/tokens/${id}`, { method: 'DELETE' }), onSuccess: () => queryClient.invalidateQueries({ queryKey: ['tokens'] }) });
  return <><Header eyebrow="Integrations" title="API tokens" /><div className="grid gap-6 p-5 sm:p-8 lg:grid-cols-[22rem_1fr]"><section className="rounded-xl border border-slate-800 bg-slate-900/40 p-5"><label className="grid gap-1 text-sm">Token name<input value={name} onChange={(event) => setName(event.target.value)} /></label><Button className="mt-3" disabled={!name || create.isPending} onClick={() => create.mutate()}><Plus size={16} /> Create intake token</Button>{newToken && <div className="mt-4 rounded-md border border-amber-400/40 bg-amber-400/10 p-3 text-sm text-amber-100"><p className="font-semibold">Copy this now — it will not be shown again.</p><code className="mt-2 block break-all text-xs">{newToken}</code></div>}</section><section className="rounded-xl border border-slate-800 bg-slate-900/40 p-5"><h2 className="font-semibold text-white">Active and revoked tokens</h2><div className="mt-4 grid gap-2">{tokens.data?.map((token) => <div key={token.id} className="flex items-center justify-between gap-4 rounded-md border border-slate-800 p-3"><div><p className="font-medium">{token.name}</p><p className="text-xs text-slate-500">{token.prefix}… {token.revokedAt ? '· revoked' : ''}</p></div>{!token.revokedAt && <Button tone="danger" onClick={() => revoke.mutate(token.id)}>Revoke</Button>}</div>)}</div></section></div></>;
};

export const App = () => (
  <Shell>
    <Switch>
      <Route path="/opportunities/:id">{(params) => <OpportunityDetail id={params.id} />}</Route>
      <Route path="/opportunities"><OpportunitiesPage /></Route>
      <Route path="/contacts"><ContactsPage /></Route>
      <Route path="/settings/fields"><FieldsPage /></Route>
      <Route path="/settings/tokens"><TokensPage /></Route>
      <Route><OpportunitiesPage /></Route>
    </Switch>
  </Shell>
);
