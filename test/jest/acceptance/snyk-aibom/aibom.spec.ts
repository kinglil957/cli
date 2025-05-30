import { runSnykCLI } from '../../util/runSnykCLI';
import {
  fakeServer,
  getFirstIPv4Address,
} from '../../../acceptance/fake-server';
import { getServerPort } from '../../util/getServerPort';
import { resolve } from 'path';
import { readFileSync } from 'fs';
import { runCommand } from '../../util/runCommand';

import { fakeDeepCodeServer } from '../../../acceptance/deepcode-fake-server';

jest.setTimeout(1000 * 60 * 5);

describe('snyk aibom (mocked servers only)', () => {
  let server: ReturnType<typeof fakeServer>;
  let deepCodeServer: ReturnType<typeof fakeDeepCodeServer>;
  let env: Record<string, string>;
  const port = getServerPort(process);
  const baseApi = '/api/v1';
  const ipAddress = getFirstIPv4Address();
  const initialEnvVars = {
    ...process.env,
    SNYK_API: `http://${ipAddress}:${port}${baseApi}`,
    SNYK_HOST: `http://${ipAddress}:${port}`,
    SNYK_TOKEN: '123456789',
    SNYK_CFG_ORG: '5dd84065-6aa9-4749-81de-fc7f23a2b8e1',
  };
  const projectRoot = resolve(__dirname, '../../../..');
  const pythonChatbotProject = resolve(
    projectRoot,
    'test/fixtures/ai-bom/python-chatbot',
  );
  const pythonRequirementsProject = resolve(
    projectRoot,
    'test/fixtures/ai-bom/requirements',
  );

  const notSupportedProject = resolve(
    projectRoot,
    'test/fixtures/ai-bom/not-supported',
  );

  beforeAll(() => {
    return new Promise<void>((resolve, reject) => {
      try {
        let serversReady = 0;
        const totalServers = 2;
        const checkAndResolve = () => {
          serversReady++;
          if (serversReady === totalServers) {
            resolve();
          }
        };

        deepCodeServer = fakeDeepCodeServer();
        deepCodeServer.listen(checkAndResolve);
        server = fakeServer(baseApi, 'snykToken');
        server.listen(port, checkAndResolve);
      } catch (error) {
        reject(error);
      }
    });
  });

  beforeEach(() => {
    jest.resetAllMocks();
    server.restore();
    deepCodeServer.restore();
    env = {
      ...initialEnvVars,
      SNYK_CODE_CLIENT_PROXY_URL: `http://${ipAddress}:${deepCodeServer.getPort()}`,
    };
    deepCodeServer.setFiltersResponse({
      configFiles: [],
      extensions: ['.py', '.snykdepgraph'],
      autofixExtensions: [],
    });
    const sarifPayload = readFileSync(
      `${projectRoot}/test/fixtures/ai-bom/sample-ai-bom-sarif.json`,
    ).toString();
    deepCodeServer.setSarifResponse(sarifPayload);
  });

  afterAll(() => {
    return new Promise<void>((resolve) => {
      deepCodeServer.close(() => {
        server.close(() => {
          resolve();
        });
      });
    });
  });

  test('`aibom` generates an AI-BOM CycloneDX with components', async () => {
    const { code, stdout, stderr } = await runSnykCLI(
      `aibom ${pythonChatbotProject} --experimental -d`,
      {
        env,
      },
    );
    let bom: any;
    console.log(stderr);
    expect(code).toEqual(0);
    expect(() => {
      bom = JSON.parse(stdout);
    }).not.toThrow();

    const deeproxyRequestUrls = deepCodeServer
      .getRequests()
      .map((req) => `${req.method}:${req.url}`);
    expect(deeproxyRequestUrls).toEqual([
      'GET:/filters',
      'POST:/bundle',
      'POST:/analysis',
    ]);

    expect(bom).toMatchObject({
      $schema: 'https://cyclonedx.org/schema/bom-1.6.schema.json',
      specVersion: '1.6',
      bomFormat: 'CycloneDX',
    });
    expect(bom.components.length).toBeGreaterThan(1);
  });

  test.only('`aibom` adds the depgraph to the bundle', async () => {
    const pipResult = await runCommand(
      'pip',
      ['install', '-r', 'requirements.txt'],
      {
        shell: true,
        cwd: pythonRequirementsProject,
      },
    );

    expect(pipResult.code).toBe(0);
    console.log(pipResult.stdout);

    // const x = await runSnykCLI(`depgraph`, {
    //   env,
    //   cwd: pythonChatbotProject,
    // });
    const { code, stdout, stderr } = await runSnykCLI(
      `aibom ${pythonRequirementsProject} --experimental -d`,
      {
        env,
      },
    );
    let bom: any;
    console.log(stderr);
    // expect(stderr).toBe('');
    const deeproxyRequestUrls = deepCodeServer
      .getRequests()
      .map((req) => `${req.method}:${req.url}`);
    expect(deeproxyRequestUrls).toEqual([
      'GET:/filters',
      'PUT:/bundle/',
      'POST:/bundle',
      'PUT:/bundle/bundle-hash',
      'POST:/analysis',
    ]);

    const deepcodeBundleCreateRequest = deepCodeServer.getRequests()[1];
    expect(deepcodeBundleCreateRequest.body).toEqual('/bundle/bundle-hash');
    const deepcodeBundleRequest = deepCodeServer.getRequests()[2];
    expect(deepcodeBundleRequest.url).toEqual('/bundle/bundle-hash');
    expect(deepcodeBundleRequest.body).toEqual({ fail: true });

    expect(code).toEqual(0);
    expect(() => {
      bom = JSON.parse(stdout);
    }).not.toThrow();

    expect(bom).toMatchObject({
      $schema: 'https://cyclonedx.org/schema/bom-1.6.schema.json',
      specVersion: '1.6',
      bomFormat: 'CycloneDX',
    });
    expect(bom.components.length).toBeGreaterThan(1);
  });

  test('`aibom` generates an AI-BOM CycloneDX in the HTML format', async () => {
    const { code, stdout } = await runSnykCLI(
      `aibom ${pythonChatbotProject} --experimental --html`,
      {
        env,
      },
    );
    expect(code).toEqual(0);
    expect(stdout).toContain('<!DOCTYPE html>');
    expect(stdout).toContain(
      'https://cyclonedx.org/schema/bom-1.6.schema.json',
    );
  });

  describe('aibom error handling', () => {
    test('handles a missing experimental flag', async () => {
      const { code, stdout } = await runSnykCLI(
        `aibom ${pythonChatbotProject}`,
        {
          env,
        },
      );
      expect(code).toEqual(2);
      expect(stdout).toContain('Command is experimental (SNYK-CLI-0015)');
    });

    test('handles unauthenticated', async () => {
      deepCodeServer.setAnalysisHandler((req, res) => {
        res.status(401).send();
      });
      console.log(pythonChatbotProject);
      const { code, stdout } = await runSnykCLI(
        `aibom ${pythonChatbotProject} --experimental`,
        {
          env,
        },
      );
      expect(code).toEqual(2);
      expect(stdout).toContain('Authentication error (SNYK-0005)');
    });

    test('handles org has no access', async () => {
      deepCodeServer.setAnalysisHandler((req, res) => {
        res.status(403).send();
      });
      console.log(pythonChatbotProject);
      const { code, stdout } = await runSnykCLI(
        `aibom ${pythonChatbotProject} --experimental`,
        {
          env,
        },
      );
      expect(code).toEqual(2);
      expect(stdout).toContain('Forbidden (SNYK-AI-BOM-0002)');
    });

    test('handles an unsupported project', async () => {
      const { code, stdout } = await runSnykCLI(
        `aibom ${notSupportedProject} --experimental`,
        {
          env,
        },
      );
      expect(code).toEqual(2);
      expect(stdout).toContain('No supported files (SNYK-AI-BOM-0003)');
    });
  });
});
