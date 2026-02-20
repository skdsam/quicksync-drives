import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';

export interface FtpConnection {
    id: string;
    name: string;
    host: string;
    port: number;
    username: string;
    password?: string;
    secure?: boolean;
}

export interface CloudConnection {
    id: string;
    provider: string;
    account_name: string;
    token: string;
}

export interface AppConfig {
    ftp_connections: FtpConnection[];
    cloud_connections: CloudConnection[];
}

interface ConfigStore {
    config: AppConfig;
    loading: boolean;
    error: string | null;
    loadConfig: () => Promise<void>;
    saveConfig: (newConfig: AppConfig) => Promise<void>;
}

export const useConfigStore = create<ConfigStore>((set) => ({
    config: { ftp_connections: [], cloud_connections: [] },
    loading: true,
    error: null,

    loadConfig: async () => {
        set({ loading: true, error: null });
        try {
            const config = await invoke<AppConfig>('load_config');
            set({ config, loading: false });
        } catch (err: any) {
            set({ error: err.toString(), loading: false });
        }
    },

    saveConfig: async (newConfig: AppConfig) => {
        try {
            await invoke('save_config', { config: newConfig });
            set({ config: newConfig });
        } catch (err: any) {
            set({ error: err.toString() });
        }
    }
}));
