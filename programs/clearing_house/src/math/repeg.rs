use crate::error::*;
use crate::math::amm;
use crate::math::casting::{cast_to_i128, cast_to_u128};
use crate::math::constants::{
    SHARE_OF_FEES_ALLOCATED_TO_CLEARING_HOUSE_DENOMINATOR,
    SHARE_OF_FEES_ALLOCATED_TO_CLEARING_HOUSE_NUMERATOR,
};
use crate::math::position::_calculate_base_asset_value_and_pnl;
use crate::math_error;
use crate::state::market::Market;
use crate::state::state::OracleGuardRails;
use anchor_lang::prelude::AccountInfo;
use solana_program::msg;

pub fn calculate_repeg_validity_full(
    market: &mut Market,
    price_oracle: &AccountInfo,
    terminal_price_before: u128,
    clock_slot: u64,
    oracle_guard_rails: &OracleGuardRails,
) -> ClearingHouseResult<(bool, bool, bool, bool, i128)> {
    let (oracle_price, _oracle_twap, oracle_conf, _oracle_twac, _oracle_delay) =
        market.amm.get_oracle_price(price_oracle, clock_slot)?;

    let oracle_is_valid = amm::is_oracle_valid(
        &market.amm,
        price_oracle,
        clock_slot,
        &oracle_guard_rails.validity,
    )?;

    let (
        oracle_is_valid,
        direction_valid,
        profitability_valid,
        price_impact_valid,
        oracle_terminal_divergence_pct_after,
    ) = calculate_repeg_validity(
        market,
        oracle_price,
        oracle_conf,
        oracle_is_valid,
        terminal_price_before,
    )?;

    Ok((
        oracle_is_valid,
        direction_valid,
        profitability_valid,
        price_impact_valid,
        oracle_terminal_divergence_pct_after,
    ))
}

pub fn calculate_repeg_validity(
    market: &mut Market,
    oracle_price: i128,
    oracle_conf: u128,
    oracle_is_valid: bool,
    terminal_price_before: u128,
) -> ClearingHouseResult<(bool, bool, bool, bool, i128)> {
    let oracle_price_u128 = cast_to_u128(oracle_price)?;

    let terminal_price_after = amm::calculate_terminal_price(market)?;
    let oracle_terminal_spread_after = oracle_price
        .checked_sub(cast_to_i128(terminal_price_after)?)
        .ok_or_else(math_error!())?;
    let oracle_terminal_divergence_pct_after = oracle_terminal_spread_after
        .checked_shl(10)
        .ok_or_else(math_error!())?
        .checked_div(oracle_price)
        .ok_or_else(math_error!())?;

    let mut direction_valid = true;
    let mut price_impact_valid = true;
    let mut profitability_valid = true;

    // if oracle is valid: check on size/direction of repeg
    if oracle_is_valid {
        let mark_price_after = amm::calculate_price(
            market.amm.quote_asset_reserve,
            market.amm.base_asset_reserve,
            market.amm.peg_multiplier,
        )?;

        let oracle_conf_band_top = oracle_price_u128
            .checked_add(oracle_conf)
            .ok_or_else(math_error!())?;

        let oracle_conf_band_bottom = oracle_price_u128
            .checked_sub(oracle_conf)
            .ok_or_else(math_error!())?;

        if oracle_price_u128 > terminal_price_after {
            // only allow terminal up when oracle is higher
            if terminal_price_after < terminal_price_before {
                direction_valid = false;
            }

            // only push terminal up to top of oracle confidence band
            if oracle_conf_band_bottom < terminal_price_after {
                profitability_valid = false;
            }

            // only push mark up to top of oracle confidence band
            if mark_price_after > oracle_conf_band_top {
                price_impact_valid = false;
            }
        } else if oracle_price_u128 < terminal_price_after {
            // only allow terminal down when oracle is lower
            if terminal_price_after > terminal_price_before {
                direction_valid = false;
            }

            // only push terminal down to top of oracle confidence band
            if oracle_conf_band_top > terminal_price_after {
                profitability_valid = false;
            }

            // only push mark down to bottom of oracle confidence band
            if mark_price_after < oracle_conf_band_bottom {
                price_impact_valid = false;
            }
        }
    } else {
        direction_valid = false;
        price_impact_valid = false;
        profitability_valid = false;
    }

    Ok((
        oracle_is_valid,
        direction_valid,
        profitability_valid,
        price_impact_valid,
        oracle_terminal_divergence_pct_after,
    ))
}

pub fn calculate_optimal_peg_and_cost(
    market: &mut Market,
    oracle_terminal_price_divergence: i128,
) -> ClearingHouseResult<(u128, i128)> {
    // does minimum valid repeg allowable iff satisfies the budget

    // budget is half of fee pool
    let budget = calculate_fee_pool(market)?
        .checked_div(2)
        .ok_or_else(math_error!())?;

    let mut optimal_peg: u128;
    if oracle_terminal_price_divergence > 0 {
        optimal_peg = market
            .amm
            .peg_multiplier
            .checked_add(1)
            .ok_or_else(math_error!())?;
    } else if oracle_terminal_price_divergence < 0 {
        optimal_peg = market
            .amm
            .peg_multiplier
            .checked_sub(1)
            .ok_or_else(math_error!())?;
    } else {
        optimal_peg = market.amm.peg_multiplier;
    }

    let (_, optimal_adjustment_cost) = adjust_peg_cost(market, optimal_peg)?;

    let candidate_peg: u128;
    let candidate_cost: i128;
    if optimal_adjustment_cost > 0 && optimal_adjustment_cost.unsigned_abs() > budget {
        candidate_peg = market.amm.peg_multiplier;
        candidate_cost = 0;
    } else {
        candidate_peg = optimal_peg;
        candidate_cost = optimal_adjustment_cost;
    }

    Ok((candidate_peg, candidate_cost))
}

pub fn adjust_peg_cost(
    market: &mut Market,
    new_peg_candidate: u128,
) -> ClearingHouseResult<(&mut Market, i128)> {
    let market_deep_copy = market;

    // Find the net market value before adjusting peg
    let (current_net_market_value, _) = _calculate_base_asset_value_and_pnl(
        market_deep_copy.base_asset_amount,
        0,
        &market_deep_copy.amm,
    )?;

    market_deep_copy.amm.peg_multiplier = new_peg_candidate;

    let (_new_net_market_value, cost) = _calculate_base_asset_value_and_pnl(
        market_deep_copy.base_asset_amount,
        current_net_market_value,
        &market_deep_copy.amm,
    )?;

    Ok((market_deep_copy, cost))
}

pub fn calculate_fee_pool(market: &Market) -> ClearingHouseResult<u128> {
    let total_fee_minus_distributions_lower_bound = total_fee_lower_bound(&market)?;

    let fee_pool = market
        .amm
        .total_fee_minus_distributions
        .checked_sub(total_fee_minus_distributions_lower_bound)
        .ok_or_else(math_error!())?;

    Ok(fee_pool)
}

pub fn total_fee_lower_bound(market: &Market) -> ClearingHouseResult<u128> {
    let total_fee_lb = market
        .amm
        .total_fee
        .checked_mul(SHARE_OF_FEES_ALLOCATED_TO_CLEARING_HOUSE_NUMERATOR)
        .ok_or_else(math_error!())?
        .checked_div(SHARE_OF_FEES_ALLOCATED_TO_CLEARING_HOUSE_DENOMINATOR)
        .ok_or_else(math_error!())?;

    Ok(total_fee_lb)
}
