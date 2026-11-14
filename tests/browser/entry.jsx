import React from 'react';
import { createRoot } from 'react-dom/client';
import { LoginForm } from '../../components/login-form';
import { LzrHubApp } from '../../components/lzr-hub-app';
import { installFixtures } from './fixtures.mjs';

installFixtures(window.fixtureData);
// Limit this harness to the selected customer workflow after real LoginForm navigation.
if (window.location.pathname !== '/login' && !window.location.hash) window.location.hash = '#/clientes';
createRoot(document.getElementById('root')).render(
  window.location.pathname === '/login' ? <LoginForm/> : <LzrHubApp/>,
);
