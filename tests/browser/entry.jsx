import React from 'react';
import { createRoot } from 'react-dom/client';
import { LoginForm } from '../../components/login-form';
import { LzrHubApp } from '../../components/lzr-hub-app';
import { installFixtures } from './fixtures.mjs';
import { installHandoffFixtures } from './handoff-fixtures.mjs';
import { installBillingFixtures } from './billing-fixtures.mjs';
import { installSearchFixtures } from './search-fixtures.mjs';

installFixtures(window.fixtureData);
if (new URLSearchParams(location.search).has('searchCase')) installSearchFixtures(window.fixtureData);
if (new URLSearchParams(location.search).has('handoffRole')) installHandoffFixtures();
if (new URLSearchParams(location.search).has('billingCase')) installBillingFixtures();
// Limit this harness to the selected customer workflow after real LoginForm navigation.
if (window.location.pathname !== '/login' && !window.location.hash) window.location.hash = '#/clientes';
createRoot(document.getElementById('root')).render(
  window.location.pathname === '/login' ? <LoginForm/> : <LzrHubApp/>,
);
