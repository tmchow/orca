import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { colors } from '../src/theme/mobile-theme'
import { OrcaLogo } from '../src/components/OrcaLogo'

export default function RootLayout() {
  return (
    <>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.bgPanel },
          headerTintColor: colors.textPrimary,
          headerTitleStyle: { fontSize: 16, fontWeight: '600' },
          contentStyle: { backgroundColor: colors.bgBase },
          headerShadowVisible: false
        }}
      >
        <Stack.Screen
          name="index"
          options={{
            headerShown: false,
            headerTitle: () => <OrcaLogo size={22} />
          }}
        />
        <Stack.Screen name="pair-scan" options={{ headerShown: false }} />
        <Stack.Screen name="settings" options={{ headerShown: false }} />
        <Stack.Screen name="about" options={{ headerShown: false }} />
        <Stack.Screen name="h" options={{ headerShown: false }} />
      </Stack>
    </>
  )
}
