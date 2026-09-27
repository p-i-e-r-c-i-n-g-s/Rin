import type { ReactNode } from "react";
import { Helmet } from "react-helmet";
import type { ConfigWrapper } from "@rin/config";
import type { Profile } from "../state/profile";
import { ClientConfigContext } from "../state/config";
import { ProfileContext } from "../state/profile";

export function AppProviders({
  children,
  config,
  profile,
}: {
  children: ReactNode;
  config: ConfigWrapper;
  profile: Profile | undefined | null;
}) {
  return (
    <ClientConfigContext.Provider value={config}>
      <ProfileContext.Provider value={profile}>
        <Helmet>
          {/* The ?v= is the cache bust. /favicon.ico answers max-age=31536000,
              so a browser holding the old icon never asks again. When the
              stored favicon changes, raise the number. */}
          <link rel="icon" href="/favicon.ico?v=2" />
        </Helmet>
        {children}
      </ProfileContext.Provider>
    </ClientConfigContext.Provider>
  );
}
