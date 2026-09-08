import { BrandLink, HeaderActions, Menu, NavBar } from "..";
import { PreviewActions, PreviewBrand, PreviewCanvas, PreviewContent, PreviewNav } from "../preview-primitives";
import type { HeaderLayoutDefinition } from "../layout-types";

const PREVIEW_ITEMS = ["Blog", "Timeline", "Tags"];

export const classicLayoutDefinition: HeaderLayoutDefinition = {
  kind: "top",
  renderDesktop({ children, profile, siteConfig }) {
    return (
      <div className="hidden w-full items-center justify-between md:flex">
        <BrandLink
          siteConfig={siteConfig}
          className="terminal-brand mr-6 hidden flex-row items-center md:flex"
          titleClassName="terminal-brand-title"
          descriptionClassName="terminal-brand-description"
        />
        <div className="flex min-w-0 flex-1 items-center justify-center">
          <div className="terminal-nav-shell">
            <div className="terminal-nav-links min-w-0 max-w-full">
              <div className="flex min-w-0 flex-row flex-wrap items-center">
                <NavBar menu={false} itemClassName="whitespace-nowrap px-2 py-2 md:p-2 text-[13px]" />
              </div>
            </div>
          </div>
        </div>
        <div className="ml-8 hidden flex-row items-center space-x-2 md:flex">
          {children ? <div className="flex items-center text-sm t-primary">{children}</div> : null}
          <HeaderActions profile={profile} className="flex flex-row items-center space-x-2" />
        </div>
      </div>
    );
  },
  renderMobile({ children, profile, siteConfig }) {
    return (
      <div className="flex w-full flex-row items-center justify-center md:hidden">
        <div className="w-full flex-row items-center justify-center transition-all duration-500">
          <div className="terminal-nav-shell terminal-nav-shell-mobile">
            <BrandLink
              siteConfig={siteConfig}
              compact
              className="visible mr-auto flex flex-row items-center py-2 opacity-100 duration-300 md:hidden"
            />
            <NavBar menu={false} itemClassName="px-2 py-2 text-xs" />
            <div className="ml-auto flex items-center gap-1">
              {children ? <div className="flex items-center text-sm t-primary">{children}</div> : null}
              <Menu profile={profile} />
            </div>
          </div>
        </div>
      </div>
    );
  },
  renderPreview(data) {
    return (
      <PreviewCanvas className="w-full overflow-hidden rounded-[22px] p-3">
        <div className="grid grid-cols-[auto_1fr_auto] items-center gap-3">
          <PreviewBrand data={data} />
          <div className="mx-2 flex min-w-0 items-center justify-center">
            <div className="max-w-full rounded-full bg-white px-2 py-2 shadow-lg shadow-black/5 ring-1 ring-black/5 dark:bg-white/[0.08] dark:shadow-black/20 dark:ring-white/10">
              <PreviewNav center items={PREVIEW_ITEMS} themeColor={data.themeColor} />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="h-6 w-6 rounded-full bg-black/[0.04] dark:bg-white/[0.08]" />
            <PreviewActions themeColor={data.themeColor} />
          </div>
        </div>
        <PreviewContent />
      </PreviewCanvas>
    );
  },
  renderRouteShell({ header, content, footer }) {
    return (
      <>
        {header}
        {content}
        {footer}
      </>
    );
  },
};
