package com.playport.server

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ReinvitePolicyTest {
    private val cooldown = 20_000L

    @Test
    fun neverReinvitesDuringASession() {
        assertFalse(shouldReinvite(true, false, true, 60_000, cooldown))
    }

    @Test
    fun waitsForARunningBootstrapThatHasNotHadASession() {
        assertFalse(shouldReinvite(false, true, false, 60_000, cooldown))
    }

    @Test
    fun reinvitesWhenASessionEndedOnARunningBootstrap() {
        assertTrue(shouldReinvite(false, true, true, 60_000, cooldown))
    }

    @Test
    fun respectsTheCooldown() {
        assertFalse(shouldReinvite(false, true, true, 19_999, cooldown))
        assertTrue(shouldReinvite(false, true, true, 20_000, cooldown))
    }

    @Test
    fun reinvitesWhenTheBootstrapHasStopped() {
        assertTrue(shouldReinvite(false, false, false, 20_000, cooldown))
    }
}
