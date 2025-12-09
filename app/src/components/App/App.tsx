import {
  DialogProvider,
  ProgressProvider,
  PromptProvider,
  ToastProvider,
} from "dialog-hooks"
import React, { useEffect } from "react"
import { HelmetProvider } from "react-helmet-async"
import { ActionDialog } from "../../components/Dialog/ActionDialog"
import { isRunningInElectron } from "../../helpers/platform"
import { ArrangeViewProvider } from "../../hooks/useArrangeView"
import { AuthProvider } from "../../hooks/useAuth"
import { PianoRollProvider } from "../../hooks/usePianoRoll"
import { StoreContext } from "../../hooks/useStores"
import { TempoEditorProvider } from "../../hooks/useTempoEditor"
import { initializeAPIBridge, stopAPIBridge } from "../../services/APIBridge"
import RootStore from "../../stores/RootStore"
import { ThemeProvider } from "../../theme/ThemeProvider"
import { ProgressDialog } from "../Dialog/ProgressDialog"
import { PromptDialog } from "../Dialog/PromptDialog"
import { RootView } from "../RootView/RootView"
import { GlobalCSS } from "../Theme/GlobalCSS"
import { Toast } from "../ui/Toast"
import { ElectronCallbackHandler } from "./ElectronCallbackHandler"
import { LocalizationProvider } from "./LocalizationProvider"
import { MCPProvider } from "../../hooks/useMCP"

const rootStore = new RootStore()

// Initialize API bridge for MCP integration
// Use VITE_MCP_WS_URL env var for local dev, otherwise auto-detect from current host
const mcpWsUrl = import.meta.env.VITE_MCP_WS_URL as string | undefined
const apiBridge = initializeAPIBridge(rootStore, mcpWsUrl)

export function App() {
  return (
    <React.StrictMode>
      <StoreContext.Provider value={rootStore}>
        <ThemeProvider>
          <HelmetProvider>
            <ToastProvider component={Toast}>
              <PromptProvider component={PromptDialog}>
                <DialogProvider component={ActionDialog}>
                  <ProgressProvider component={ProgressDialog}>
                    <LocalizationProvider>
                      <AuthProvider>
                        <MCPProvider bridge={apiBridge}>
                          <PianoRollProvider>
                            <ArrangeViewProvider>
                              <TempoEditorProvider>
                                <GlobalCSS />
                                {isRunningInElectron() && (
                                  <ElectronCallbackHandler />
                                )}
                                <RootView />
                              </TempoEditorProvider>
                            </ArrangeViewProvider>
                          </PianoRollProvider>
                        </MCPProvider>
                      </AuthProvider>
                    </LocalizationProvider>
                  </ProgressProvider>
                </DialogProvider>
              </PromptProvider>
            </ToastProvider>
          </HelmetProvider>
        </ThemeProvider>
      </StoreContext.Provider>
    </React.StrictMode>
  )
}
