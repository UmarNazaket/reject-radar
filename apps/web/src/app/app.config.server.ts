import { type ApplicationConfig, mergeApplicationConfig } from '@angular/core';
import { provideServerRendering, withRoutes } from '@angular/ssr';
import type { Locale } from '@rejectradar/contracts/locales';
import { CATALOGS } from '@rejectradar/i18n';
import { appConfig } from './app.config';
import { serverRoutes } from './app.routes.server';
import { CATALOG_LOADER } from './core/i18n';

/** The catalogs come from the i18n library, as the build has no server to fetch them from. Only this config imports it. */
const serverConfig: ApplicationConfig = {
  providers: [provideServerRendering(withRoutes(serverRoutes)), { provide: CATALOG_LOADER, useValue: async (locale: Locale) => CATALOGS[locale] }],
};

export const config = mergeApplicationConfig(appConfig, serverConfig);
