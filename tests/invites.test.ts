import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { prisma } from '../src/lib/prisma';

const app = createApp();

async function login(email: string): Promise<string | null> {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ email, password: 'Demo123!' });
  if (res.status !== 200) return null;
  return res.body.data.accessToken;
}

describe('Invites API', () => {
  let adminToken: string | null;

  beforeAll(async () => {
    adminToken = await login('admin@digitalkingsmen.com');
  });

  it('lists registration tokens for admin', async () => {
    if (!adminToken) return;

    const res = await request(app)
      .get('/api/invites/registration-tokens')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.tokens?.length).toBeGreaterThanOrEqual(4);
    const client = res.body.data.tokens.find((t: { token: string }) => t.token === 'dk-register-client');
    expect(client).toBeDefined();
  });

  it('POST /invites creates one-time invite', async () => {
    if (!adminToken) return;

    const company = await prisma.company.findFirst({ select: { id: true } });
    if (!company) return;

    const res = await request(app)
      .post('/api/invites')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        email: `invite-${Date.now()}@example.com`,
        role: 'client',
        assignments: [{ company_id: company.id, relationship_type: 'primary_contact' }],
        send_email: false,
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.token).toBeDefined();
    expect(res.body.data.email_sent).toBe(false);
    expect(res.body.data.assignments?.[0]?.company_id).toBe(company.id);
  });

  it('GET /auth/invite-preview returns invite details', async () => {
    if (!adminToken) return;

    const company = await prisma.company.findFirst({ select: { id: true, name: true } });
    if (!company) return;

    const created = await request(app)
      .post('/api/invites')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        email: `preview-${Date.now()}@example.com`,
        role: 'client',
        assignments: [{ company_id: company.id, relationship_type: 'billing' }],
      });

    expect(created.status).toBe(201);

    const res = await request(app)
      .get('/api/auth/invite-preview')
      .query({ token: created.body.data.token });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.email).toBe(created.body.data.email);
    expect(res.body.data.role).toBe('client');
    expect(res.body.data.assignments?.[0]?.companyName).toBe(company.name);
    expect(res.body.data.assignments?.[0]?.relationshipType).toBe('billing');
  });

  it('registers contractor invite and provisions staff assignments', async () => {
    if (!adminToken) return;

    const [company, staffTag] = await Promise.all([
      prisma.company.findFirst({ select: { id: true } }),
      prisma.staffTag.findFirst({ where: { slug: 'design' }, select: { id: true } }),
    ]);
    if (!company || !staffTag) return;

    const email = `contractor-invite-${Date.now()}@example.com`;
    const created = await request(app)
      .post('/api/invites')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        email,
        role: 'contractor',
        assignments: [{ company_id: company.id, staff_tag_id: staffTag.id }],
      });

    expect(created.status).toBe(201);

    const registered = await request(app).post('/api/auth/register').send({
      email,
      password: 'Demo123!xx',
      full_name: 'Contractor Invite',
      invite_token: created.body.data.token,
    });

    expect(registered.status).toBe(201);
    expect(registered.body.data.user.role).toBe('contractor');

    const assignment = await prisma.companyStaffAssignment.findFirst({
      where: {
        companyId: company.id,
        userId: registered.body.data.user.id,
        staffTagId: staffTag.id,
      },
    });
    expect(assignment).toBeTruthy();
  });

  it('admin invite never grants super admin automatically', async () => {
    if (!adminToken) return;

    const email = `admin-invite-${Date.now()}@example.com`;
    const created = await request(app)
      .post('/api/invites')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        email,
        role: 'admin',
      });

    expect(created.status).toBe(201);

    const registered = await request(app).post('/api/auth/register').send({
      email,
      password: 'Demo123!xx',
      full_name: 'Admin Invite',
      invite_token: created.body.data.token,
    });

    expect(registered.status).toBe(201);
    expect(registered.body.data.user.role).toBe('admin');
    expect(registered.body.data.user.isSuperAdmin).not.toBe(true);
  });

  it('registers with reusable client token and any email', async () => {
    const email = `reusable-${Date.now()}@example.com`;
    const res = await request(app).post('/api/auth/register').send({
      email,
      password: 'Demo123!xx',
      full_name: 'Reusable Test',
      invite_token: 'dk-register-client',
    });

    if (res.status === 400 && res.body.error?.message?.includes('already exists')) {
      return;
    }

    expect(res.status).toBe(201);
    expect(res.body.data.user.role).toBe('client');
    expect(res.body.data.accessToken).toBeDefined();

    const again = await request(app).post('/api/auth/register').send({
      email: `reusable-2-${Date.now()}@example.com`,
      password: 'Demo123!xx',
      full_name: 'Reusable Test 2',
      invite_token: 'dk-register-client',
    });
    expect(again.status).toBe(201);
  });
});
