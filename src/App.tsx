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
import { useState } from 'react';
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
  type: string;
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

const ContactDialog = ({ open, onOpenChange }: { onOpenChange: (value: boolean) => void; open: boolean }) => {
  const queryClient = useQueryClient();
  const form = useForm<ContactInput>({
    defaultValues: { email: '', firstName: '', lastName: '' },
    resolver: effectTsResolver(ContactInputSchema),
  });
  const mutation = useMutation({
    mutationFn: (input: ContactInput) => request<Contact>('/v1/contacts', { body: JSON.stringify(input), method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['contacts'] });
      onOpenChange(false);
      form.reset();
    },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="New contact">
      <form className="grid gap-4" onSubmit={form.handleSubmit((values) => mutation.mutate(values))}>
        <label className="grid gap-1 text-sm text-slate-300">First name<input {...form.register('firstName')} placeholder="Sam" /></label>
        <label className="grid gap-1 text-sm text-slate-300">Last name<input {...form.register('lastName')} placeholder="Rivera" /></label>
        <label className="grid gap-1 text-sm text-slate-300">Email<input {...form.register('email')} placeholder="sam@example.com" type="email" /></label>
        {Object.values(form.formState.errors).map((error, index) => <p key={index} className="text-sm text-rose-300">{String(error.message ?? "Invalid value.")}</p>)}
        {mutation.error && <ErrorState error={mutation.error} />}
        <div className="flex justify-end gap-2"><Button tone="secondary" onClick={() => onOpenChange(false)}>Cancel</Button><Button disabled={mutation.isPending} type="submit">Create contact</Button></div>
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
      <div className="mt-3 flex items-center justify-between text-xs text-slate-500"><span>{opportunity.source}</span>{opportunity.estimatedValue !== null && <span>${opportunity.estimatedValue.toLocaleString()}</span>}</div>
    </Link>
  );
};

const OpportunitiesPage = () => {
  const [showContact, setShowContact] = useState(false);
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
      <Header eyebrow="Work queue" title="Opportunities" action={<Button onClick={() => setShowContact(true)}><Plus size={16} /> Add contact</Button>} />
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
      <ContactDialog open={showContact} onOpenChange={setShowContact} />
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
      <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-5"><h2 className="font-semibold text-white">Contact</h2><p className="mt-3 text-lg">{[record.contact.firstName, record.contact.lastName].filter(Boolean).join(' ') || 'Unnamed contact'}</p><p className="text-sm text-slate-400">{record.contact.email ?? 'No email'}</p><div className="mt-6 grid gap-3 border-t border-slate-800 pt-5 text-sm">{Object.entries(record.customFields).map(([key, value]) => <div key={key} className="flex justify-between gap-4"><span className="text-slate-400">{key}</span><span>{String(value)}</span></div>)}</div></section>
      <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-5"><h2 className="font-semibold text-white">Activity</h2><form className="mt-4 grid gap-2" onSubmit={(event) => { event.preventDefault(); if (note.trim()) addNote.mutate(); }}><textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="Add a note…" rows={3} /><Button disabled={addNote.isPending} type="submit">Add note</Button></form><div className="mt-5 grid gap-4">{activities.data?.map((activity) => <article key={activity.id} className="border-l border-slate-700 pl-3"><p className="text-sm text-slate-200">{activity.body}</p><p className="mt-1 text-xs text-slate-500">{activity.kind.replaceAll('_', ' ')} · {new Date(activity.createdAt).toLocaleString()}</p></article>)}</div></section>
    </div>
  </>;
};

const ContactsPage = () => {
  const contacts = useQuery(appQuery.contacts());
  if (contacts.error) return <div className="p-8"><ErrorState error={contacts.error} /></div>;
  return <><Header eyebrow="People" title="Contacts" /> <div className="p-5 sm:p-8">{contacts.isPending ? <p className="text-slate-400">Loading contacts…</p> : <div className="overflow-hidden rounded-xl border border-slate-800"><table className="w-full text-left text-sm"><thead className="bg-slate-900 text-xs uppercase tracking-wider text-slate-400"><tr><th className="px-4 py-3">Name</th><th className="px-4 py-3">Email</th><th className="px-4 py-3">Added</th></tr></thead><tbody>{contacts.data?.map((contact) => <tr key={contact.id} className="border-t border-slate-800"><td className="px-4 py-3 font-medium text-slate-100">{[contact.firstName, contact.lastName].filter(Boolean).join(' ') || 'Unnamed contact'}</td><td className="px-4 py-3 text-slate-400">{contact.email ?? '—'}</td><td className="px-4 py-3 text-slate-500">{new Date(contact.createdAt).toLocaleDateString()}</td></tr>)}</tbody></table></div>}</div></>;
};

const FieldsPage = () => {
  const queryClient = useQueryClient();
  const [entityType, setEntityType] = useState<'contact' | 'opportunity'>('opportunity');
  const form = useForm<CreateCustomField>({
    defaultValues: { entityType: 'opportunity', key: '', label: '', required: false, type: 'text' },
    resolver: effectTsResolver(CreateCustomFieldSchema),
  });
  const fields = useQuery({ queryFn: () => request<FieldDefinition[]>(`/v1/custom-fields?entityType=${entityType}`), queryKey: ['fields', entityType] });
  const create = useMutation({
    mutationFn: (input: CreateCustomField) => request('/v1/custom-fields', { body: JSON.stringify({ ...input, options: input.options?.filter(Boolean) }), method: 'POST' }),
    onSuccess: () => { form.reset({ entityType, key: '', label: '', required: false, type: 'text' }); queryClient.invalidateQueries({ queryKey: ['fields', entityType] }); },
  });
  const archive = useMutation({ mutationFn: (id: string) => request(`/v1/custom-fields/${id}`, { method: 'DELETE' }), onSuccess: () => queryClient.invalidateQueries({ queryKey: ['fields', entityType] }) });
  return <><Header eyebrow="Configuration" title="Custom fields" /><div className="grid gap-6 p-5 sm:p-8 lg:grid-cols-[22rem_1fr]"><section className="rounded-xl border border-slate-800 bg-slate-900/40 p-5"><form className="grid gap-3" onSubmit={form.handleSubmit((values) => create.mutate(values))}><label className="grid gap-1 text-sm">Record<select {...form.register('entityType')} onChange={(event) => { form.setValue('entityType', event.target.value as 'contact' | 'opportunity'); setEntityType(event.target.value as 'contact' | 'opportunity'); }}><option value="opportunity">Opportunity</option><option value="contact">Contact</option></select></label><label className="grid gap-1 text-sm">Label<input {...form.register('label')} placeholder="Cohort" /></label><label className="grid gap-1 text-sm">Key<input {...form.register('key')} placeholder="cohort" /></label><label className="grid gap-1 text-sm">Type<select {...form.register('type')}><option value="text">Text</option><option value="number">Number</option><option value="boolean">Boolean</option><option value="date">Date</option><option value="select">Select</option></select></label><label className="flex gap-2 text-sm"><input type="checkbox" {...form.register('required')} /> Required</label><Button disabled={create.isPending} type="submit"><Plus size={16} /> Add field</Button>{create.error && <ErrorState error={create.error} />}</form></section><section className="rounded-xl border border-slate-800 bg-slate-900/40 p-5"><h2 className="font-semibold text-white">Active {entityType} fields</h2><div className="mt-4 grid gap-2">{fields.data?.map((field) => <div key={field.id} className="flex items-center justify-between gap-4 rounded-md border border-slate-800 p-3"><div><p className="font-medium">{field.label}</p><p className="text-xs text-slate-500">{field.key} · {field.type}</p></div><Button tone="secondary" onClick={() => archive.mutate(field.id)}>Archive</Button></div>)}</div></section></div></>;
};

const TokensPage = () => {
  const queryClient = useQueryClient();
  const [name, setName] = useState('ÎleO form intake');
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
