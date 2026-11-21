import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { SharedArray } from 'k6/data';

/*
|--------------------------------------------------------------------------
| Basic configuration
|--------------------------------------------------------------------------
*/

const BASE_URL = (
  __ENV.BASE_URL ||
  'http://192.168.11.24:8002'
).replace(/\/+$/, '');

const TEST_TYPE = String(
  __ENV.TEST_TYPE || 'load'
).toLowerCase();

const VUS = parsePositiveInteger(
  __ENV.VUS || '1',
  'VUS'
);

const DURATION =
  __ENV.DURATION || '1m';

/*
|--------------------------------------------------------------------------
| Login configuration
|--------------------------------------------------------------------------
|
| LOGIN_MODE=json
| Sends login credentials using application/json.
|
| LOGIN_MODE=form
| Sends login credentials using application/x-www-form-urlencoded.
|
*/

const LOGIN_PATH =
  __ENV.LOGIN_PATH ||
  '/api/v1/auth/login';

const LOGIN_MODE = String(
  __ENV.LOGIN_MODE || 'json'
).toLowerCase();

const LOGIN_USERNAME_FIELD =
  __ENV.LOGIN_USERNAME_FIELD ||
  'username';

const LOGIN_PASSWORD_FIELD =
  __ENV.LOGIN_PASSWORD_FIELD ||
  'password';

if (
  LOGIN_MODE !== 'json' &&
  LOGIN_MODE !== 'form'
) {
  throw new Error(
    `Invalid LOGIN_MODE "${LOGIN_MODE}". ` +
    'Allowed values are json and form.'
  );
}

/*
|--------------------------------------------------------------------------
| JWT and tenant configuration
|--------------------------------------------------------------------------
*/

const TOKEN_PATH =
  __ENV.TOKEN_PATH ||
  'access_token';

const AUTH_HEADER =
  __ENV.AUTH_HEADER ||
  'Authorization';

const AUTH_PREFIX =
  __ENV.AUTH_PREFIX === undefined
    ? 'Bearer '
    : __ENV.AUTH_PREFIX;

const TENANT_HEADER =
  __ENV.TENANT_HEADER ||
  'X-Tenant-Slug';

if (!TENANT_HEADER.trim()) {
  throw new Error(
    'TENANT_HEADER cannot be empty.'
  );
}

/*
|--------------------------------------------------------------------------
| Read-only API requests
|--------------------------------------------------------------------------
|
| Update these paths according to the actual API paths used by the CRM.
|
| Set any path to:
|
| disabled
|
| or:
|
| -
|
| to skip that request.
|
*/

const READ_REQUESTS = [
  {
    name: 'dashboard',
    method: 'GET',
    path:
      __ENV.DASHBOARD_PATH ||
      '/api/v1/dashboard',
  },
  {
    name: 'customers',
    method: 'GET',
    path:
      __ENV.CUSTOMERS_PATH ||
      '/api/v1/customers?page=1&page_size=20',
  },
  {
    name: 'leads',
    method: 'GET',
    path:
      __ENV.LEADS_PATH ||
      '/api/v1/leads?page=1&page_size=20',
  },
  {
    name: 'global_search',
    method: 'GET',
    path:
      __ENV.SEARCH_PATH ||
      '/api/v1/search?q=test',
  },
].filter((request) => {
  if (!request.path) {
    return false;
  }

  const normalizedPath = String(
    request.path
  )
    .trim()
    .toLowerCase();

  return (
    normalizedPath !== '-' &&
    normalizedPath !== 'disabled'
  );
});

/*
|--------------------------------------------------------------------------
| Users
|--------------------------------------------------------------------------
|
| users.json must be stored in the same directory as load-test.js.
|
| Every user must contain:
|
| {
|   "username": "username",
|   "password": "password",
|   "tenant_slug": "tenant"
| }
|
*/

const users = new SharedArray(
  'CRM load-test users',
  function loadUsers() {
    let loadedUsers;

    try {
      loadedUsers = JSON.parse(
        open('./users.json')
      );
    } catch (error) {
      const message =
        error && error.message
          ? error.message
          : String(error);

      throw new Error(
        `Unable to read or parse users.json: ${message}`
      );
    }

    if (
      !Array.isArray(loadedUsers) ||
      loadedUsers.length === 0
    ) {
      throw new Error(
        'users.json must contain at least one user.'
      );
    }

    return loadedUsers.map(
      (rawUser, index) => {
        if (
          !rawUser ||
          typeof rawUser !== 'object' ||
          Array.isArray(rawUser)
        ) {
          throw new Error(
            `users.json entry ${index + 1} must be an object.`
          );
        }

        const username = String(
          rawUser.username || ''
        ).trim();

        const password = String(
          rawUser.password || ''
        );

        const tenantSlug = String(
          rawUser.tenant_slug || ''
        ).trim();

        if (!username) {
          throw new Error(
            `users.json entry ${index + 1} is missing username.`
          );
        }

        if (!password) {
          throw new Error(
            `users.json entry ${index + 1} is missing password.`
          );
        }

        if (!tenantSlug) {
          throw new Error(
            `users.json entry ${index + 1} is missing tenant_slug.`
          );
        }

        return {
          username,
          password,
          tenant_slug: tenantSlug,
        };
      }
    );
  }
);

/*
|--------------------------------------------------------------------------
| Scenario selection
|--------------------------------------------------------------------------
*/

function buildScenarios() {
  switch (TEST_TYPE) {
    /*
    |--------------------------------------------------------------------------
    | Burst test
    |--------------------------------------------------------------------------
    |
    | Every VU performs exactly one complete journey.
    |
    | All configured read APIs are called in parallel after login.
    |
    */

    case 'burst':
      return {
        crm_burst: {
          executor: 'per-vu-iterations',
          vus: VUS,
          iterations: 1,
          maxDuration: DURATION,
          gracefulStop: '30s',
        },
      };

    /*
    |--------------------------------------------------------------------------
    | Spike test
    |--------------------------------------------------------------------------
    |
    | Gradually starts a small number of users and then rapidly increases
    | the load to the configured VUS value.
    |
    */

    case 'spike':
      return {
        crm_spike: {
          executor: 'ramping-vus',
          startVUs: 1,
          stages: [
            {
              duration: '30s',
              target: Math.max(
                1,
                Math.ceil(VUS * 0.1)
              ),
            },
            {
              duration: '15s',
              target: VUS,
            },
            {
              duration: DURATION,
              target: VUS,
            },
            {
              duration: '30s',
              target: 0,
            },
          ],
          gracefulRampDown: '30s',
          gracefulStop: '30s',
        },
      };

    /*
    |--------------------------------------------------------------------------
    | Normal load test
    |--------------------------------------------------------------------------
    */

    case 'load':
      return {
        crm_load: {
          executor: 'constant-vus',
          vus: VUS,
          duration: DURATION,
          gracefulStop: '30s',
        },
      };

    /*
    |--------------------------------------------------------------------------
    | Soak test
    |--------------------------------------------------------------------------
    |
    | Uses the same constant VU executor as the load test.
    | Use a longer DURATION for a soak test.
    |
    */

    case 'soak':
      return {
        crm_soak: {
          executor: 'constant-vus',
          vus: VUS,
          duration: DURATION,
          gracefulStop: '30s',
        },
      };

    default:
      throw new Error(
        `Invalid TEST_TYPE "${TEST_TYPE}". ` +
        'Allowed values are load, soak, burst, and spike.'
      );
  }
}

/*
|--------------------------------------------------------------------------
| k6 options and thresholds
|--------------------------------------------------------------------------
*/

export const options = {
  scenarios: buildScenarios(),

  thresholds: {
    /*
    | Less than 2% of all HTTP requests can fail.
    */

    http_req_failed: [
      'rate<0.02',
    ],

    /*
    | 95% of all HTTP requests must complete within 3 seconds.
    */

    http_req_duration: [
      'p(95)<3000',
    ],

    /*
    | At least 98% of all checks must pass.
    */

    checks: [
      'rate>0.98',
    ],
  },
};

/*
|--------------------------------------------------------------------------
| Per-VU authentication state
|--------------------------------------------------------------------------
|
| Every k6 VU has its own JavaScript runtime.
|
| Therefore, these values are maintained separately for every VU.
|
*/

let loggedIn = false;
let authToken = null;
let authenticatedUsername = null;
let authenticatedTenantSlug = null;

/*
|--------------------------------------------------------------------------
| Validate positive integer environment variables
|--------------------------------------------------------------------------
*/

function parsePositiveInteger(
  value,
  variableName
) {
  const parsedValue = Number(value);

  if (
    !Number.isFinite(parsedValue) ||
    parsedValue < 1 ||
    Math.floor(parsedValue) !== parsedValue
  ) {
    throw new Error(
      `${variableName} must be a positive integer. ` +
      `Received value: ${value}`
    );
  }

  return parsedValue;
}

/*
|--------------------------------------------------------------------------
| Build complete request URL
|--------------------------------------------------------------------------
*/

function buildUrl(path) {
  const requestedPath = String(
    path || ''
  ).trim();

  if (!requestedPath) {
    throw new Error(
      'Cannot build a URL from an empty path.'
    );
  }

  /*
  | Allow complete URLs for backward compatibility.
  */

  if (
    /^https?:\/\//i.test(requestedPath)
  ) {
    return requestedPath;
  }

  return (
    `${BASE_URL}/` +
    requestedPath.replace(/^\/+/, '')
  );
}

/*
|--------------------------------------------------------------------------
| Read nested object property
|--------------------------------------------------------------------------
|
| Example:
|
| getObjectValue(responseBody, 'data.access_token')
|
*/

function getObjectValue(
  source,
  objectPath
) {
  if (
    source === null ||
    source === undefined ||
    !objectPath
  ) {
    return null;
  }

  return String(objectPath)
    .split('.')
    .reduce((current, key) => {
      if (
        current === null ||
        current === undefined
      ) {
        return null;
      }

      return current[key];
    }, source);
}

/*
|--------------------------------------------------------------------------
| JWT token extraction
|--------------------------------------------------------------------------
|
| Supports common token response formats:
|
| {
|   "access_token": "..."
| }
|
| {
|   "token": "..."
| }
|
| {
|   "data": {
|     "access_token": "..."
|   }
| }
|
| {
|   "result": {
|     "token": "..."
|   }
| }
|
*/

function getToken(body) {
  const tokenPaths = [
    TOKEN_PATH,
    'access_token',
    'token',
    'jwt',
    'data.access_token',
    'data.token',
    'data.jwt',
    'result.access_token',
    'result.token',
    'result.jwt',
  ];

  for (
    let index = 0;
    index < tokenPaths.length;
    index += 1
  ) {
    const token = getObjectValue(
      body,
      tokenPaths[index]
    );

    if (
      typeof token === 'string' &&
      token.trim() !== ''
    ) {
      return token.trim();
    }
  }

  return null;
}

/*
|--------------------------------------------------------------------------
| Assign a user to the current VU
|--------------------------------------------------------------------------
|
| __VU starts from 1.
|
| VU 1 uses users.json index 0.
| VU 2 uses users.json index 1.
|
| If VUS is greater than the number of users, the users are reused using
| modulo assignment.
|
*/

function getUserForVU() {
  const userIndex =
    (__VU - 1) % users.length;

  return users[userIndex];
}

/*
|--------------------------------------------------------------------------
| Base headers
|--------------------------------------------------------------------------
|
| The tenant header is always taken from the assigned user's tenant_slug.
|
| No global TENANT value is used.
|
*/

function baseHeaders(user) {
  if (!user) {
    throw new Error(
      `VU ${__VU}: assigned user is missing.`
    );
  }

  if (!user.tenant_slug) {
    throw new Error(
      `VU ${__VU}: tenant_slug is missing for user ${user.username}.`
    );
  }

  const headers = {
    Accept: 'application/json',
  };

  headers[TENANT_HEADER] =
    user.tenant_slug;

  return headers;
}

/*
|--------------------------------------------------------------------------
| Authenticated request headers
|--------------------------------------------------------------------------
*/

function authenticatedHeaders(
  user,
  extraHeaders
) {
  const headers = Object.assign(
    {},
    extraHeaders || {},
    baseHeaders(user)
  );

  if (authToken) {
    headers[AUTH_HEADER] =
      `${AUTH_PREFIX}${authToken}`;
  }

  return headers;
}

/*
|--------------------------------------------------------------------------
| Case-insensitive header search
|--------------------------------------------------------------------------
*/

function hasHeader(
  headers,
  headerName
) {
  const expectedHeader =
    String(headerName).toLowerCase();

  return Object.keys(headers).some(
    (existingHeader) => {
      return (
        existingHeader.toLowerCase() ===
        expectedHeader
      );
    }
  );
}

/*
|--------------------------------------------------------------------------
| Check whether this VU is authenticated as the assigned user
|--------------------------------------------------------------------------
*/

function isAuthenticatedAs(user) {
  return (
    loggedIn === true &&
    authenticatedUsername ===
      user.username &&
    authenticatedTenantSlug ===
      user.tenant_slug
  );
}

/*
|--------------------------------------------------------------------------
| Reset authentication state
|--------------------------------------------------------------------------
*/

function resetAuthentication() {
  loggedIn = false;
  authToken = null;
  authenticatedUsername = null;
  authenticatedTenantSlug = null;
}

/*
|--------------------------------------------------------------------------
| Safely print response body
|--------------------------------------------------------------------------
|
| Limits the response body written to the console to avoid very large logs.
|
*/

function safeResponseBody(response) {
  if (
    !response ||
    response.body === null ||
    response.body === undefined
  ) {
    return '';
  }

  const body = String(
    response.body
  );

  const maximumLength = 1000;

  if (
    body.length <= maximumLength
  ) {
    return body;
  }

  return (
    body.slice(0, maximumLength) +
    '... [response body truncated]'
  );
}

/*
|--------------------------------------------------------------------------
| Encode form request body
|--------------------------------------------------------------------------
*/

function encodeFormBody(payload) {
  return Object.keys(payload)
    .map((key) => {
      return (
        `${encodeURIComponent(key)}=` +
        `${encodeURIComponent(payload[key])}`
      );
    })
    .join('&');
}

/*
|--------------------------------------------------------------------------
| Login
|--------------------------------------------------------------------------
|
| The assigned user and the assigned user's tenant_slug are used for every
| login request.
|
*/

function login(user) {
  resetAuthentication();

  if (
    !user.username ||
    !user.password ||
    !user.tenant_slug
  ) {
    console.error(
      `VU ${__VU}: invalid user configuration. ` +
      `username=${user.username || 'missing'}, ` +
      `tenant=${user.tenant_slug || 'missing'}`
    );

    return false;
  }

  const payload = {};

  payload[LOGIN_USERNAME_FIELD] =
    user.username;

  payload[LOGIN_PASSWORD_FIELD] =
    user.password;

  let response;

  /*
  |--------------------------------------------------------------------------
  | Form login
  |--------------------------------------------------------------------------
  */

  if (LOGIN_MODE === 'form') {
    const headers = baseHeaders(user);

    headers['Content-Type'] =
      'application/x-www-form-urlencoded';

    response = http.post(
      buildUrl(LOGIN_PATH),
      encodeFormBody(payload),
      {
        headers,
        timeout: '60s',
        tags: {
          module: 'authentication',
          endpoint: 'login',
          tenant: user.tenant_slug,
          username: user.username,
        },
      }
    );
  } else {
    /*
    |--------------------------------------------------------------------------
    | JSON login
    |--------------------------------------------------------------------------
    */

    const headers = baseHeaders(user);

    headers['Content-Type'] =
      'application/json';

    response = http.post(
      buildUrl(LOGIN_PATH),
      JSON.stringify(payload),
      {
        headers,
        timeout: '60s',
        tags: {
          module: 'authentication',
          endpoint: 'login',
          tenant: user.tenant_slug,
          username: user.username,
        },
      }
    );
  }

  /*
  |--------------------------------------------------------------------------
  | Validate login response
  |--------------------------------------------------------------------------
  */

  const loginPassed = check(
    response,
    {
      'login returned success status':
        (result) => {
          return (
            result.status >= 200 &&
            result.status < 300
          );
        },
    }
  );

  if (!loginPassed) {
    console.error(
      `VU ${__VU}: login failed. ` +
      `username=${user.username}, ` +
      `tenant=${user.tenant_slug}, ` +
      `url=${buildUrl(LOGIN_PATH)}, ` +
      `mode=${LOGIN_MODE}, ` +
      `status=${response.status}, ` +
      `body=${safeResponseBody(response)}`
    );

    return false;
  }

  /*
  |--------------------------------------------------------------------------
  | Extract JWT token
  |--------------------------------------------------------------------------
  |
  | k6 maintains cookies separately for every VU.
  |
  | Therefore, cookie-based authentication can still work even if the login
  | response does not contain a JWT token.
  |
  */

  try {
    const responseBody =
      response.json();

    authToken = getToken(
      responseBody
    );
  } catch (error) {
    authToken = null;
  }

  loggedIn = true;

  authenticatedUsername =
    user.username;

  authenticatedTenantSlug =
    user.tenant_slug;

  return true;
}

/*
|--------------------------------------------------------------------------
| Create request body
|--------------------------------------------------------------------------
*/

function requestBody(request) {
  if (
    request.body === undefined ||
    request.body === null
  ) {
    return null;
  }

  if (
    typeof request.body === 'string'
  ) {
    return request.body;
  }

  return JSON.stringify(
    request.body
  );
}

/*
|--------------------------------------------------------------------------
| Create authenticated request parameters
|--------------------------------------------------------------------------
*/

function requestParams(
  request,
  user
) {
  const headers =
    authenticatedHeaders(
      user,
      request.headers || {}
    );

  /*
  | Automatically set JSON Content-Type when the request has a body and the
  | request has not provided another Content-Type.
  */

  if (
    request.body !== undefined &&
    request.body !== null &&
    !hasHeader(
      headers,
      'Content-Type'
    )
  ) {
    headers['Content-Type'] =
      'application/json';
  }

  return {
    headers,
    timeout:
      request.timeout ||
      '60s',

    tags: Object.assign(
      {
        module: request.name,
        endpoint: request.name,
        tenant: user.tenant_slug,
        username: user.username,
      },
      request.tags || {}
    ),
  };
}

/*
|--------------------------------------------------------------------------
| Validate authenticated response
|--------------------------------------------------------------------------
*/

function validateResponse(
  response,
  requestName,
  user
) {
  const responsePassed = check(
    response,
    {
      [`${requestName} returned 2xx or 3xx`]:
        (result) => {
          return (
            result.status >= 200 &&
            result.status < 400
          );
        },
    }
  );

  if (!responsePassed) {
    console.error(
      `VU ${__VU}: request failed. ` +
      `username=${user.username}, ` +
      `tenant=${user.tenant_slug}, ` +
      `endpoint=${requestName}, ` +
      `status=${response.status}, ` +
      `body=${safeResponseBody(response)}`
    );
  }

  /*
  | A 401 means the token or session is no longer valid.
  |
  | Reset authentication so the VU logs in again on its next iteration.
  */

  if (response.status === 401) {
    resetAuthentication();
  }

  return responsePassed;
}

/*
|--------------------------------------------------------------------------
| Sequential user journey
|--------------------------------------------------------------------------
|
| Used by:
|
| load
| soak
| spike
|
| APIs are called one after another with think time between requests.
|
*/

function runSequentialJourney(user) {
  for (
    let index = 0;
    index < READ_REQUESTS.length;
    index += 1
  ) {
    const request =
      READ_REQUESTS[index];

    const response = http.request(
      String(
        request.method || 'GET'
      ).toUpperCase(),

      buildUrl(
        request.path
      ),

      requestBody(
        request
      ),

      requestParams(
        request,
        user
      )
    );

    validateResponse(
      response,
      request.name,
      user
    );

    /*
    | Stop the remaining journey when authentication has expired.
    |
    | The next iteration will log in again.
    */

    if (!loggedIn) {
      break;
    }

    /*
    | Simulate user think time between page requests.
    */

    sleep(
      1 + Math.random() * 2
    );
  }
}

/*
|--------------------------------------------------------------------------
| Parallel user journey
|--------------------------------------------------------------------------
|
| Used by:
|
| burst
|
| All configured APIs are called in parallel after login.
|
*/

function runParallelJourney(user) {
  if (
    READ_REQUESTS.length === 0
  ) {
    return;
  }

  const batchRequests =
    READ_REQUESTS.map(
      (request) => {
        return [
          String(
            request.method || 'GET'
          ).toUpperCase(),

          buildUrl(
            request.path
          ),

          requestBody(
            request
          ),

          requestParams(
            request,
            user
          ),
        ];
      }
    );

  const responses =
    http.batch(batchRequests);

  responses.forEach(
    (response, index) => {
      validateResponse(
        response,
        READ_REQUESTS[index].name,
        user
      );
    }
  );
}

/*
|--------------------------------------------------------------------------
| Main VU journey
|--------------------------------------------------------------------------
*/

export default function () {
  /*
  | Every VU uses its assigned user.
  */

  const user = getUserForVU();

  /*
  | This protects the VU from reusing authentication belonging to another
  | username or tenant.
  */

  if (
    loggedIn &&
    !isAuthenticatedAs(user)
  ) {
    resetAuthentication();
  }

  /*
  | Authenticate the assigned user.
  */

  if (!loggedIn) {
    const loginSuccessful =
      login(user);

    if (!loginSuccessful) {
      sleep(3);
      return;
    }
  }

  /*
  | Run the selected CRM journey.
  */

  group(
    'CRM user journey',
    function runJourneyGroup() {
      if (
        TEST_TYPE === 'burst'
      ) {
        runParallelJourney(user);
      } else {
        runSequentialJourney(user);
      }
    }
  );

  /*
  | Add a delay between complete journeys for load, soak, and spike tests.
  */

  if (
    TEST_TYPE !== 'burst'
  ) {
    sleep(
      2 + Math.random() * 3
    );
  }
}