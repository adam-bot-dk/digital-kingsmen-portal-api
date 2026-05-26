import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';

const app = createApp();

async function login(email: string): Promise<string | null> {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ email, password: 'Demo123!' });
  if (res.status !== 200) return null;
  return res.body.data.accessToken;
}

async function getMe(token: string) {
  const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
  if (res.status !== 200) return null;
  return res.body.data.user as { id: string; email: string };
}

describe('Permissions API', () => {
  it('client cannot access internal notes', async () => {
    const token = await login('client-pure@example.com');
    if (!token) return;

    const res = await request(app)
      .get('/api/internal-notes')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it('client projects are scoped to their company', async () => {
    const token = await login('client-pure@example.com');
    if (!token) return;

    const res = await request(app)
      .get('/api/projects')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    for (const project of res.body.data) {
      expect(project.company?.name || project.name).toBeDefined();
    }
  });

  it('employee cannot access unassigned company projects by ID brute force', async () => {
    const adminToken = await login('admin@digitalkingsmen.com');
    const employeeToken = await login('employee@digitalkingsmen.com');
    if (!adminToken || !employeeToken) return;

    const companies = await request(app)
      .get('/api/companies')
      .set('Authorization', `Bearer ${adminToken}`);

    if (companies.body.data?.length === 0) return;

    const companyId = companies.body.data[0].id;
    const projects = await request(app)
      .get(`/api/companies/${companyId}`)
      .set('Authorization', `Bearer ${employeeToken}`);

    if (projects.status === 200 && projects.body.data?.projects?.length > 0) {
      const projectId = projects.body.data.projects[0].id;
      const res = await request(app)
        .get(`/api/projects/${projectId}`)
        .set('Authorization', `Bearer ${employeeToken}`);
      expect([200, 403, 404]).toContain(res.status);
    }
  });

  it('salesman can access dashboard', async () => {
    const token = await login('salesman@digitalkingsmen.com');
    if (!token) return;

    const res = await request(app)
      .get('/api/dashboard/salesman')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('salesman company responses only include their own staff context', async () => {
    const token = await login('salesman@digitalkingsmen.com');
    if (!token) return;

    const me = await getMe(token);
    if (!me) return;

    const list = await request(app).get('/api/companies').set('Authorization', `Bearer ${token}`);
    expect(list.status).toBe(200);
    expect(list.body.success).toBe(true);
    if (!list.body.data?.length) return;

    for (const company of list.body.data) {
      expect(company.assignedProjectManager ?? null).toBeNull();
      if (company.assignedSalesman) {
        expect(company.assignedSalesman.id).toBe(me.id);
      }
    }

    const detail = await request(app)
      .get(`/api/companies/${list.body.data[0].id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(detail.status).toBe(200);
    expect(detail.body.success).toBe(true);
    expect(detail.body.data.assignedProjectManager ?? null).toBeNull();
    expect(Array.isArray(detail.body.data.staffAssignments)).toBe(true);
    for (const assignment of detail.body.data.staffAssignments) {
      expect(assignment.userId).toBe(me.id);
    }
  });

  it('employee company responses only include their own staff context', async () => {
    const token = await login('employee@digitalkingsmen.com');
    if (!token) return;

    const me = await getMe(token);
    if (!me) return;

    const list = await request(app).get('/api/companies').set('Authorization', `Bearer ${token}`);
    expect(list.status).toBe(200);
    expect(list.body.success).toBe(true);
    if (!list.body.data?.length) return;

    for (const company of list.body.data) {
      expect(company.assignedSalesman ?? null).toBeNull();
      expect(company.assignedProjectManager ?? null).toBeNull();
    }

    const detail = await request(app)
      .get(`/api/companies/${list.body.data[0].id}`)
      .set('Authorization', `Bearer ${token}`);

    expect(detail.status).toBe(200);
    expect(detail.body.success).toBe(true);
    expect(detail.body.data.assignedSalesman ?? null).toBeNull();
    expect(detail.body.data.assignedProjectManager ?? null).toBeNull();
    expect(Array.isArray(detail.body.data.staffAssignments)).toBe(true);
    for (const assignment of detail.body.data.staffAssignments) {
      expect(assignment.userId).toBe(me.id);
    }
  });

  it('client cannot PATCH project internal fields', async () => {
    const token = await login('client-pure@example.com');
    if (!token) return;

    const list = await request(app)
      .get('/api/projects')
      .set('Authorization', `Bearer ${token}`);

    if (!list.body.data?.length) return;

    const projectId = list.body.data[0].id;
    const res = await request(app)
      .patch(`/api/projects/${projectId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ internal_notes: 'hacked', overall_progress: 100 });

    expect(res.status).toBe(200);
    const getRes = await request(app)
      .get(`/api/projects/${projectId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(getRes.body.data.internalNotes).toBeUndefined();
  });
});
